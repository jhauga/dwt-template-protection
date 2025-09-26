import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let nonEditableDecorationType: vscode.TextEditorDecorationType;
let editableDecorationType: vscode.TextEditorDecorationType;
let outputChannel: vscode.OutputChannel;
let applyToAllForRun = false;
let previewModeForRun = false;
let cancelRunForRun = false;
let isProtectionEnabled = true;
let isProcessingUndo = false;
let isTemplateSyncEnabled = true;
let templateWatcher: vscode.FileSystemWatcher | undefined;
// Tracks whether all files in a sync run passed safety checks (undefined until run finishes or first failure occurs)

// Error/exit codes
// 0 success
// 1 error/exception
// 2 cancelled (user cancelled entire run)
// 3 skipped (user skipped this specific item)
// 4 safety-skip (user skipped due to safety issues)
function logProcessCompletion(context: string, errorCode: number = 0) {
    const line = `[dwt-site-template] Extension process completed (${context}) with error code -> ${errorCode}`;
    console.log(line);
    if (outputChannel) outputChannel.appendLine(line);
}

// Per-file protection state (key: document URI, value: protection enabled)
let fileProtectionState = new Map<string, boolean>();

// Store last backup information for restore functionality
let lastBackupInfo: { backupDir: string; templateName: string; instances: vscode.Uri[]; siteRoot: string } | undefined;

// Character preservation system for delete/backspace protection
interface DocumentSnapshot {
    content: string;
    version: number;
    timestamp: number;
}

let documentSnapshots = new Map<string, DocumentSnapshot>();
let isRestoringContent = false;

export function activate(context: vscode.ExtensionContext) {
    console.log('Dreamweaver Template Protection activated');

    // Output channel for detailed diagnostics
    outputChannel = vscode.window.createOutputChannel('Dreamweaver Template Protection');

    initializeDecorations();

    function getPositionAt(text: string, index: number): vscode.Position {
        const lines = text.substring(0, index).split('\n');
        const line = lines.length - 1;
        const character = lines[line].length;
        return new vscode.Position(line, character);
    }

    function isDreamweaverTemplate(document: vscode.TextDocument): boolean {
        const text = document.getText();
        const dreamweaverCommentRegex = /<!--\s*(?:InstanceBeginEditable|TemplateBeginEditable|InstanceEndEditable|TemplateEndEditable|#BeginTemplate)/;
        const cspCommentRegex = /;\s*--------------- (?:CAN BE EDITED|SHOULD NOT BE EDITED) -----------------/;
        return dreamweaverCommentRegex.test(text) || cspCommentRegex.test(text);
    }

    function isDreamweaverTemplateFile(document: vscode.TextDocument): boolean {
        return document.fileName.toLowerCase().endsWith('.dwt');
    }

    function shouldProtectFromEditing(document: vscode.TextDocument): boolean {
        // Allow full editing of .dwt template files
        if (isDreamweaverTemplateFile(document)) {
            return false;
        }
        // Check file-specific protection state
        const fileProtectionEnabled = getFileProtectionState(document);
        // Protect instance files (.html with Dreamweaver comments) only if protection is enabled for this file
        return fileProtectionEnabled && isDreamweaverTemplate(document);
    }

    function saveDocumentSnapshot(document: vscode.TextDocument): void {
        if (!shouldProtectFromEditing(document)) {
            return;
        }

        documentSnapshots.set(document.uri.toString(), {
            content: document.getText(),
            version: document.version,
            timestamp: Date.now()
        });
    }

    function isProtectedRegionChange(change: vscode.TextDocumentContentChangeEvent, protectedRanges: vscode.Range[], document: vscode.TextDocument): boolean {
        const changeStart = change.range.start;
        const changeEnd = change.range.end;
        
        // Check each protected range
        for (const protectedRange of protectedRanges) {
            // 1. Check if change start is within protected region
            if (protectedRange.contains(changeStart)) {
                return true;
            }
            
            // 2. Check if change end is within protected region  
            if (protectedRange.contains(changeEnd)) {
                return true;
            }
            
            // 3. Check if change range intersects with protected region
            const changeRange = new vscode.Range(changeStart, changeEnd);
            const intersect = protectedRange.intersection(changeRange);
            if (intersect && !intersect.isEmpty) {
                return true;
            }
            
            // 4. For insertions (rangeLength = 0), check if inserting at boundary of protected region
            if (change.rangeLength === 0 && change.text.length > 0) {
                if (protectedRange.start.isEqual(changeStart) || protectedRange.end.isEqual(changeStart)) {
                    return true;
                }
            }
            
            // 5. Check if the change would affect content that spans into protected region
            if (change.text.length > 0) {
                const changeEndAfterInsert = new vscode.Position(
                    changeStart.line + (change.text.split('\n').length - 1),
                    change.text.split('\n').length > 1 ? 
                        change.text.split('\n')[change.text.split('\n').length - 1].length : 
                        changeStart.character + change.text.length
                );
                const expandedChangeRange = new vscode.Range(changeStart, changeEndAfterInsert);
                const expandedIntersect = protectedRange.intersection(expandedChangeRange);
                if (expandedIntersect && !expandedIntersect.isEmpty) {
                    return true;
                }
            }
        }
        
        return false;
    }

    async function restoreFromSnapshot(editor: vscode.TextEditor): Promise<void> {
        const snapshot = documentSnapshots.get(editor.document.uri.toString());
        if (!snapshot) return;

        try {
            isRestoringContent = true;
            
            // Get current cursor position to restore after
            const currentSelection = editor.selection;
            
            // Replace entire document content with snapshot
            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(editor.document.getText().length)
            );
            
            const edit = new vscode.WorkspaceEdit();
            edit.replace(editor.document.uri, fullRange, snapshot.content);
            
            await vscode.workspace.applyEdit(edit);
            
            // Restore cursor position if still valid
            try {
                if (currentSelection.start.line < editor.document.lineCount) {
                    editor.selection = currentSelection;
                }
            } catch {
                // If position is no longer valid, place cursor at start
                editor.selection = new vscode.Selection(0, 0, 0, 0);
            }
            
        } finally {
            isRestoringContent = false;
        }
    }

    function getEditableRanges(document: vscode.TextDocument): vscode.Range[] {
        const text = document.getText();
        const ranges: vscode.Range[] = [];
        const beginRegex = /<!--\s*(?:InstanceBeginEditable|TemplateBeginEditable)\s*name=\"[^\"]+\"\s*-->/g;
        const endRegex = /<!--\s*(?:InstanceEndEditable|TemplateEndEditable)\s*-->/g;

        const beginMatches = [];
        let beginMatch;
        while ((beginMatch = beginRegex.exec(text)) !== null) {
            beginMatches.push({ index: beginMatch.index, length: beginMatch[0].length });
        }

        const endMatches = [];
        let endMatch;
        while ((endMatch = endRegex.exec(text)) !== null) {
            endMatches.push({ index: endMatch.index });
        }

        let beginIndex = 0;
        let endIndex = 0;
        while (beginIndex < beginMatches.length && endIndex < endMatches.length) {
            const begin = beginMatches[beginIndex];
            const end = endMatches[endIndex];

            if (begin.index < end.index) {
                const startPos = getPositionAt(text, begin.index + begin.length);
                const endPos = getPositionAt(text, end.index);
                ranges.push(new vscode.Range(startPos, endPos));
                beginIndex++;
                endIndex++;
            } else {
                endIndex++;
            }
        }
        return ranges;
    }

    function getProtectedRanges(document: vscode.TextDocument): vscode.Range[] {
        const text = document.getText();
        const editableRanges = getEditableRanges(document);

        if (!isDreamweaverTemplate(document) || editableRanges.length === 0) {
            return [];
        }

        const protectedRanges: vscode.Range[] = [];
        let lastPosition = new vscode.Position(0, 0);

        // The first protected range starts at the end of the first editable range.
        if (editableRanges.length > 0) {
            lastPosition = editableRanges[0].end;
        }

        // Iterate through the rest of the editable ranges to find the protected areas between them.
        for (let i = 1; i < editableRanges.length; i++) {
            const range = editableRanges[i];
            const protectedRange = new vscode.Range(lastPosition, range.start);
            if (!protectedRange.isEmpty) {
                protectedRanges.push(protectedRange);
            }
            lastPosition = range.end;
        }

        const documentEnd = getPositionAt(text, text.length);
        const finalProtectedRange = new vscode.Range(lastPosition, documentEnd);
        if (!finalProtectedRange.isEmpty) {
            protectedRanges.push(finalProtectedRange);
        }

        return protectedRanges;
    }

    function showEditableRegionsList(document: vscode.TextDocument) {
        const text = document.getText();
        const editableRanges = getEditableRanges(document);
        const regionNames: string[] = [];
        const beginRegex = /<!--\s*(?:InstanceBeginEditable|TemplateBeginEditable)\s*name=\"([^\"]+)\"\s*-->/g;
        let match;
        while ((match = beginRegex.exec(text)) !== null) {
            regionNames.push(match[1]);
        }

        if (regionNames.length > 0) {
            vscode.window.showQuickPick(regionNames, {
                placeHolder: 'Select an editable region to navigate to'
            }).then(selectedRegion => {
                if (selectedRegion) {
                    const selectedIndex = regionNames.indexOf(selectedRegion);
                    if (selectedIndex >= 0 && selectedIndex < editableRanges.length) {
                        const range = editableRanges[selectedIndex];
                        const editor = vscode.window.activeTextEditor;
                        if (editor) {
                            editor.selection = new vscode.Selection(range.start, range.start);
                            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        }
                    }
                }
            });
        } else {
            vscode.window.showInformationMessage('No editable regions found in this template.');
        }
    }

    function initializeDecorations() {
        // No decoration for editable regions
        editableDecorationType = vscode.window.createTextEditorDecorationType({});

        // For non-editable regions, reduce the opacity to subtly gray them out.
        // This works well across different themes.
        nonEditableDecorationType = vscode.window.createTextEditorDecorationType({
            opacity: '0.6'
        });
    }

    // Get protection state for specific file (defaults to global setting)
    function getFileProtectionState(document: vscode.TextDocument): boolean {
        const uri = document.uri.toString();
        const fileState = fileProtectionState.get(uri);
        if (fileState !== undefined) {
            return fileState;
        }
        // Default to global setting
        const config = vscode.workspace.getConfiguration('dreamweaverTemplate');
        return config.get('enableProtection', true);
    }

    // Set protection state for specific file
    function setFileProtectionState(document: vscode.TextDocument, enabled: boolean): void {
        const uri = document.uri.toString();
        fileProtectionState.set(uri, enabled);
        outputChannel.appendLine(`[PROTECTION] File protection ${enabled ? 'enabled' : 'disabled'} for: ${document.fileName}`);
    }

    function updateDecorations(editor: vscode.TextEditor | undefined) {
        if (!editor) {
            return;
        }

        const fileProtectionEnabled = getFileProtectionState(editor.document);

        // Clear decorations if protection is disabled or if this is a .dwt file
        if (!fileProtectionEnabled || isDreamweaverTemplateFile(editor.document)) {
            editor.setDecorations(nonEditableDecorationType, []);
            editor.setDecorations(editableDecorationType, []);
            return;
        }

        // Only apply decorations to instance files (not .dwt files)
        if (!isDreamweaverTemplate(editor.document)) {
            editor.setDecorations(nonEditableDecorationType, []);
            editor.setDecorations(editableDecorationType, []);
            return;
        }

        const config = vscode.workspace.getConfiguration('dreamweaverTemplate');
        const protectedRanges = getProtectedRanges(editor.document);
        const editableRanges = getEditableRanges(editor.document);

        editor.setDecorations(nonEditableDecorationType, config.get('highlightProtectedRegions', true) ? protectedRanges : []);
        editor.setDecorations(editableDecorationType, config.get('highlightEditableRegions', true) ? editableRanges : []);
    }

    // Workspace / context validation helper
    function ensureWorkspaceContext(templateUri?: vscode.Uri): boolean {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open. Open the site root folder to use Dreamweaver template features.');
            return false;
        }
        if (templateUri && !templateUri.fsPath.toLowerCase().endsWith('.dwt')) {
            vscode.window.showWarningMessage('Active file is not a .dwt template. Open a .dwt file for this command.');
            return false;
        }
        return true;
    }

    // Create backup of files (html/php/dwt) before updating, preserving folder structure
    async function createHtmlBackups(instances: vscode.Uri[], templatePath: string): Promise<string> {
        try {
            // Get template name without extension for folder naming
            const templateName = path.basename(templatePath, '.dwt');
            
            // Get site root (parent of Templates directory)
            const templateDir = path.dirname(templatePath);
            const siteRoot = path.dirname(templateDir);
            const backupDir = path.join(siteRoot, '.dwt-template-protection-backups');
            const templateBackupDir = path.join(backupDir, templateName);
            
            console.log(`Creating backup directory structure for template: ${templateName}`);
            
            // Create backup directory structure if it doesn't exist
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }
            if (!fs.existsSync(templateBackupDir)) {
                fs.mkdirSync(templateBackupDir, { recursive: true });
            }
            
            // Implement rolling backup system (keep 3 backups max)
            // Step 1: Check if backup folders exist and shift them
            const backup3Dir = path.join(templateBackupDir, '3');
            const backup2Dir = path.join(templateBackupDir, '2');
            const backup1Dir = path.join(templateBackupDir, '1');
            
            // If backup 3 exists, remove it (it will be overwritten)
            if (fs.existsSync(backup3Dir)) {
                fs.rmSync(backup3Dir, { recursive: true, force: true });
                console.log(`Removed oldest backup: ${backup3Dir}`);
            }
            
            // Move backup 2 to backup 3
            if (fs.existsSync(backup2Dir)) {
                fs.renameSync(backup2Dir, backup3Dir);
                console.log(`Moved backup 2 to backup 3`);
            }
            
            // Move backup 1 to backup 2
            if (fs.existsSync(backup1Dir)) {
                fs.renameSync(backup1Dir, backup2Dir);
                console.log(`Moved backup 1 to backup 2`);
            }
            
            // Create new backup 1 directory
            fs.mkdirSync(backup1Dir, { recursive: true });
            
            console.log(`Backing up ${instances.length} file(s) (html/php/dwt) to: ${backup1Dir}`);
            
            // Backup each file to the new backup 1 directory, preserving relative path
            for (const instanceUri of instances) {
                try {
                    if (instanceUri.fsPath.includes('.dwt-template-protection-backups')) {
                        // Never back up backup files
                        continue;
                    }
                    const relPath = path.relative(siteRoot, instanceUri.fsPath);
                    const backupPath = path.join(backup1Dir, relPath);
                    // ensure directory exists
                    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
                    
                    // Copy file to backup location
                    const content = fs.readFileSync(instanceUri.fsPath, 'utf8');
                    fs.writeFileSync(backupPath, content, 'utf8');
                    
                    console.log(`Backed up: ${relPath}`);
                } catch (error) {
                    console.error(`Error backing up ${instanceUri.fsPath}:`, error);
                }
            }
            
            console.log(`All files backed up to: ${backup1Dir}`);
            
            // Store backup info for restore functionality
            lastBackupInfo = { backupDir: backup1Dir, templateName, instances, siteRoot };
            
            return backup1Dir;
            
        } catch (error) {
            console.error('Error creating HTML backups:', error);
            throw new Error(`Failed to create HTML backups: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Restore HTML files from last backup
    async function restoreHtmlFromBackup(): Promise<void> {
        if (!lastBackupInfo) {
            vscode.window.showErrorMessage('No backup information found. Cannot restore files.');
            return;
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Restoring HTML from backup',
            cancellable: false
        }, async (progress) => {
            try {
                const { backupDir, templateName, siteRoot } = lastBackupInfo!;
                if (!fs.existsSync(backupDir)) {
                    vscode.window.showErrorMessage(`Backup directory not found: ${backupDir}`);
                    return;
                }
                progress.report({ message: `Found backup for template ${templateName}`, increment: 5 });

                // Collect all files in backupDir recursively
                const listFilesRecursively = (dir: string): string[] => {
                    const out: string[] = [];
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const full = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            out.push(...listFilesRecursively(full));
                        } else {
                            out.push(full);
                        }
                    }
                    return out;
                };

                const files = listFilesRecursively(backupDir);
                let restoredCount = 0;
                let failedCount = 0;
                const total = files.length || 1;
                for (let i = 0; i < files.length; i++) {
                    const backupFile = files[i];
                    const rel = path.relative(backupDir, backupFile);
                    const target = path.join(siteRoot, rel);
                    if (target.includes('.dwt-template-protection-backups')) {
                        // Do not restore into backup folder path
                        continue;
                    }
                    try {
                        const content = fs.readFileSync(backupFile, 'utf8');
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        fs.writeFileSync(target, content, 'utf8');
                        restoredCount++;
                    } catch (e) {
                        console.error(`Failed restore for ${rel}:`, e);
                        failedCount++;
                    }
                    progress.report({ increment: 80 / total, message: `Restored ${i + 1}/${total}` });
                }

                const message = `Restored ${restoredCount} file(s) from template "${templateName}" backup${failedCount ? ` (${failedCount} failed)` : ''}`;
                progress.report({ increment: 15, message: 'Done' });
                vscode.window.showInformationMessage(message);
            } catch (error) {
                console.error('Error restoring HTML from backup:', error);
                vscode.window.showErrorMessage(`Failed to restore HTML files: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    // Find all templates that use a given template (template hierarchy)
    async function findChildTemplates(templatePath: string): Promise<vscode.Uri[]> {
        const childTemplates: vscode.Uri[] = [];
        const templateName = path.basename(templatePath);
        
        try {
            // Find all .dwt files in the Templates directory
            const templateFiles = await vscode.workspace.findFiles('**/Templates/*.dwt', '{**/node_modules/**,**/.dwt-template-protection-backups/**}');
            
            for (const templateFile of templateFiles) {
                // Skip the current template
                if (templateFile.fsPath === templatePath) {
                    continue;
                }
                
                try {
                    const content = fs.readFileSync(templateFile.fsPath, 'utf8');
                    const headSlice = content.slice(0, 600);
                    // Check if this template references our template (only in top portion)
                    const instanceBeginRegex = /<!--\s*InstanceBegin\s+template="([^"]+)"/i;
                    const match = headSlice.match(instanceBeginRegex);
                    
                    if (match) {
                        const referencedTemplate = match[1];
                        const referencedTemplateName = path.basename(referencedTemplate);
                        if (referencedTemplateName === templateName) {
                            childTemplates.push(templateFile);
                            console.log(`Found child template (exact): ${templateFile.fsPath} references ${templateName}`);
                        } else {
                            console.log(`Ignoring template ${templateFile.fsPath} referencing different template ${referencedTemplateName}`);
                        }
                    }
                } catch (error) {
                    console.error(`Error reading template file ${templateFile.fsPath}:`, error);
                }
            }
        } catch (error) {
            console.error('Error finding child templates:', error);
        }
        
        return childTemplates;
    }

    // Template Synchronization Functions
    async function findTemplateInstances(templatePath: string): Promise<vscode.Uri[]> {
        const templateName = path.basename(templatePath);
        const instances: vscode.Uri[] = [];
        
        console.log(`DEBUG: Starting findTemplateInstances for ${templatePath}`);
        console.log(`DEBUG: Template name: ${templateName}`);
        
        try {
            // Check if the template is in a "Templates" folder
            const templateDir = path.dirname(templatePath);
            const templateDirName = path.basename(templateDir);
            
            console.log(`DEBUG: Template directory: ${templateDir}`);
            console.log(`DEBUG: Template directory name: ${templateDirName}`);
            
            if (templateDirName !== 'Templates') {
                console.log(`DEBUG: Template not in Templates folder, skipping instance search`);
                return instances;
            }
            
            // Get the parent directory of "Templates" (this is the site root)
            const siteRoot = path.dirname(templateDir);
            console.log(`DEBUG: Site root determined as: ${siteRoot}`);
            
            // Convert to workspace-relative path for VS Code's findFiles
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                console.log(`DEBUG: No workspace folder found`);
                return instances;
            }
            
            console.log(`DEBUG: Workspace folder: ${workspaceFolder.uri.fsPath}`);
            
            const siteRootRelative = path.relative(workspaceFolder.uri.fsPath, siteRoot);
            let searchPattern: string;
            
            console.log(`DEBUG: Site root relative to workspace: "${siteRootRelative}"`);
            
            if (siteRootRelative === '') {
                searchPattern = '**/*.{html,php}';
            } else {
                searchPattern = `${siteRootRelative}/**/*.{html,php}`;
            }
            
            console.log(`DEBUG: Searching for HTML/PHP files with pattern: ${searchPattern}`);
            
            // Find all HTML files within the site root and its subdirectories
            // Exclude node_modules and backup directories
            const htmlFiles = await vscode.workspace.findFiles(searchPattern, '{**/node_modules/**,**/.dwt-template-protection-backups/**}');
            
            console.log(`DEBUG: Found ${htmlFiles.length} HTML/PHP files to check (excluding backups)`);
            htmlFiles.forEach(file => console.log(`DEBUG: Candidate file: ${file.fsPath}`));
            
            for (const file of htmlFiles) {
                try {
                    // Skip backup files as an additional safety check
                    if (file.fsPath.includes('.dwt-template-protection-backups')) {
                        console.log(`DEBUG: Skipping backup file: ${file.fsPath}`);
                        continue;
                    }
                    
                    const content = fs.readFileSync(file.fsPath, 'utf8');
                    // Limit search to first 600 chars (top lines) to avoid false positives deep in body
                    const headSlice = content.slice(0, 600);
                    const instanceBeginRegex = /<!--\s*InstanceBegin\s+template="([^"]+)"/i;
                    const match = headSlice.match(instanceBeginRegex);
                    
                    if (match) {
                        const referencedTemplate = match[1];
                        console.log(`DEBUG: File ${file.fsPath} references template: ${referencedTemplate}`);
                        
                        // Check if it references our template (handle both absolute and relative paths)
                        // IMPORTANT: Only match EXACTLY our template, not partial matches
                        const referencedTemplateName = path.basename(referencedTemplate);
                        if (referencedTemplateName === templateName) {
                            instances.push(file);
                            console.log(`DEBUG: Added instance: ${file.fsPath} (exact template match)`);
                        } else {
                            console.log(`DEBUG: Skipped ${file.fsPath}: references ${referencedTemplateName}, not ${templateName}`);
                        }
                    }
                } catch (error) {
                    console.error(`Error reading file ${file.fsPath}:`, error);
                }
            }
            
            console.log(`DEBUG: Found ${instances.length} template instances for ${templateName}`);
        } catch (error) {
            console.error('Error finding template instances:', error);
        }
        
        return instances;
    }

    // Update template based on another template (for template hierarchy)
    async function updateTemplateBasedOnTemplate(childTemplateUri: vscode.Uri, parentTemplatePath: string): Promise<boolean> {
        try {
            const childTemplateContent = fs.readFileSync(childTemplateUri.fsPath, 'utf8');
            const parentTemplateContent = fs.readFileSync(parentTemplatePath, 'utf8');
            
            console.log(`Updating template: ${childTemplateUri.fsPath} based on parent: ${parentTemplatePath}`);
            
            // Step 1: PRESERVE the original InstanceBegin comment from child template (don't change it!)
            const instanceBeginMatch = childTemplateContent.match(/<!--\s*InstanceBegin\s+template="([^"]+)"[^>]*-->/);
            let preservedInstanceBegin = '';
            if (instanceBeginMatch) {
                preservedInstanceBegin = '\n' + instanceBeginMatch[0];
                console.log(`Preserving original InstanceBegin: ${instanceBeginMatch[0]}`);
            } else {
                // If no InstanceBegin found, create one that references the parent template
                const parentTemplateName = path.basename(parentTemplatePath);
                preservedInstanceBegin = `\n<!-- InstanceBegin template="/Templates/${parentTemplateName}" codeOutsideHTMLIsLocked="true" -->`;
                console.log(`Creating new InstanceBegin referencing parent template: ${parentTemplateName}`);
            }
            
            // Step 2: Extract editable content from child template (both Instance and Template regions)
            const editableContent = new Map<string, string>();
            
            // Extract InstanceBeginEditable regions
            const instanceEditableRegex = /<!--\s*InstanceBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*InstanceEndEditable\s*-->/g;
            let match;
            while ((match = instanceEditableRegex.exec(childTemplateContent)) !== null) {
                const regionName = match[1];
                const content = match[2];
                editableContent.set(regionName, content);
                console.log(`Preserved InstanceEditable region "${regionName}"`);
            }
            
            // Extract TemplateBeginEditable regions (in case child template has both)
            const templateEditableRegex = /<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndEditable\s*-->/g;
            while ((match = templateEditableRegex.exec(childTemplateContent)) !== null) {
                const regionName = match[1];
                const content = match[2];
                editableContent.set(regionName, content);
                console.log(`Preserved TemplateEditable region "${regionName}"`);
            }
            
            // Step 3: Start with parent template content
            let updatedContent = parentTemplateContent;
            
            // Step 4: Replace parent TemplateBeginEditable with InstanceBeginEditable + preserved content
            const templateRegionRegex = /<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndEditable\s*-->/g;
            
            updatedContent = updatedContent.replace(templateRegionRegex, (fullMatch, regionName, defaultContent) => {
                const preservedContent = editableContent.get(regionName) || defaultContent;
                console.log(`Replacing parent template region "${regionName}" with preserved content`);
                return `<!-- InstanceBeginEditable name="${regionName}" -->${preservedContent}<!-- InstanceEndEditable -->`;
            });
            
            // Step 5: Add the PRESERVED InstanceBegin comment (keep original parent reference)
            updatedContent = updatedContent.replace(/<!--\s*InstanceBegin\s+template=[^>]*-->\s*/g, '');
            updatedContent = updatedContent.replace(/(<html[^>]*>)/i, `$1${preservedInstanceBegin}`);
            console.log(`Added preserved InstanceBegin comment (keeping original parent template reference)`);
            
            // Step 6: Add InstanceEnd comment before </html>
            updatedContent = updatedContent.replace(/<!--\s*InstanceEnd\s*-->/g, '');
            updatedContent = updatedContent.replace(/(<\/html>)/i, '<!-- InstanceEnd -->$1');
            
            // Step 7: Write updated content to child template file
            fs.writeFileSync(childTemplateUri.fsPath, updatedContent, 'utf8');
            
            console.log(`Successfully updated template: ${childTemplateUri.fsPath}`);
            return true;
        } catch (error) {
            console.error(`Error updating template ${childTemplateUri.fsPath}:`, error);
            return false;
        }
    }

    // New Dreamweaver-style template updating that preserves editable content surgically
    type MergeResultStatus = 'updated' | 'unchanged' | 'skipped' | 'safetyFailed' | 'cancelled' | 'error';
    interface MergeResult { status: MergeResultStatus; }
    async function updateHtmlLikeDreamweaver(instanceUri: vscode.Uri, templatePath: string): Promise<MergeResult> {
        try {
            const instancePath = instanceUri.fsPath;
            console.log(`[DW-MERGE] Start merge for instance: ${instancePath}`);
            outputChannel.appendLine(`[DW-MERGE] Start merge for instance: ${instancePath}`);

            const rawInstance = fs.readFileSync(instancePath, 'utf8');
            const rawTemplate = fs.readFileSync(templatePath, 'utf8');
            const instanceContent = rawInstance.replace(/\r\n?/g, '\n');
            const templateContent = rawTemplate.replace(/\r\n?/g, '\n');

            // Capture repeat blocks from instance and template for preservation
            const instanceRepeatBlocks = new Map<string, string>();
            try {
                const instRepeatRe = /<!--\s*InstanceBeginRepeat\s+name="([^"]+)"\s*-->[\s\S]*?<!--\s*InstanceEndRepeat\s*-->/gi;
                let im: RegExpExecArray | null;
                while ((im = instRepeatRe.exec(instanceContent)) !== null) {
                    instanceRepeatBlocks.set(im[1], im[0]);
                }
            } catch {}
            const templateRepeatBlocks = new Map<string, { full: string; name: string }>();
            try {
                const tmplRepeatRe = /<!--\s*TemplateBeginRepeat\s+name="([^"]+)"\s*-->[\s\S]*?<!--\s*TemplateEndRepeat\s*-->/gi;
                let tm: RegExpExecArray | null;
                while ((tm = tmplRepeatRe.exec(templateContent)) !== null) {
                    templateRepeatBlocks.set(tm[1], { full: tm[0], name: tm[1] });
                }
            } catch {}

            // Preserve existing instance editable regions
            const preservedRegions = new Map<string, string>();
            const instanceEditablePattern = /<!--\s*InstanceBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*InstanceEndEditable\s*-->/g;
            let m: RegExpExecArray | null;
            while ((m = instanceEditablePattern.exec(instanceContent)) !== null) {
                preservedRegions.set(m[1], m[2]);
            }
            console.log(`[DW-MERGE] Preserved regions (${preservedRegions.size}): ${Array.from(preservedRegions.keys()).join(', ') || '(none)'}`);
            outputChannel.appendLine(`[DW-MERGE] Preserved regions (${preservedRegions.size}): ${Array.from(preservedRegions.keys()).join(', ') || '(none)'}`);

            // Robust region parser for template (handles single-line regions):
            interface ParsedRegion { name: string; begin: number; end: number; defaultContent: string; full: string; }
            const regionPattern = /<!--\s*(TemplateBeginEditable|InstanceBeginEditable)\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*(TemplateEndEditable|InstanceEndEditable)\s*-->/g;
            const parsedRegions: ParsedRegion[] = [];
            let rp: RegExpExecArray | null;
            while ((rp = regionPattern.exec(templateContent)) !== null) {
                parsedRegions.push({
                    name: rp[2],
                    begin: rp.index,
                    end: rp.index + rp[0].length,
                    defaultContent: rp[3],
                    full: rp[0]
                });
            }
            console.log(`[DW-MERGE] Template regions parsed: ${parsedRegions.map(r=>r.name).join(', ') || '(none)'}`);
            outputChannel.appendLine(`[DW-MERGE] Template regions parsed: ${parsedRegions.map(r=>r.name).join(', ') || '(none)'}`);
            const templateRegionNames = new Set(parsedRegions.map(r => r.name));
            // Scan template for ALL editable names (in case parser misses ones inside repeats)
            const allTemplateEditableNames = new Set<string>();
            const editablePositions: { name: string; index: number }[] = [];
            try {
                const scanEditableNames = /<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->/gi;
                let nm: RegExpExecArray | null;
                while ((nm = scanEditableNames.exec(templateContent)) !== null) {
                    allTemplateEditableNames.add(nm[1]);
                    editablePositions.push({ name: nm[1], index: nm.index });
                }
            } catch {}
            // Heuristic: detect which editables sit inside a TemplateBeginRepeat..TemplateEndRepeat block
            const namesInsideRepeat = new Set<string>();
            const isInsideRepeat = (atIndex: number): boolean => {
                const upTo = templateContent.slice(0, atIndex);
                const lastBegin = upTo.lastIndexOf('TemplateBeginRepeat');
                const lastEnd = upTo.lastIndexOf('TemplateEndRepeat');
                return lastBegin !== -1 && (lastEnd === -1 || lastBegin > lastEnd);
            };
            for (const pos of editablePositions) {
                if (isInsideRepeat(pos.index)) {
                    namesInsideRepeat.add(pos.name);
                }
            }

            // Build segments (static/region)
            type Segment = { kind: 'static'; text: string } | { kind: 'region'; region: ParsedRegion };
            const segments: Segment[] = [];
            let cursor = 0;
            for (const r of parsedRegions) {
                if (r.begin > cursor) {
                    segments.push({ kind: 'static', text: templateContent.slice(cursor, r.begin) });
                }
                segments.push({ kind: 'region', region: r });
                cursor = r.end;
            }
            if (cursor < templateContent.length) {
                segments.push({ kind: 'static', text: templateContent.slice(cursor) });
            }
            console.log(`[DW-MERGE] Segments -> static:${segments.filter(s=>s.kind==='static').length} region:${segments.filter(s=>s.kind==='region').length}`);
            outputChannel.appendLine(`[DW-MERGE] Segments -> static:${segments.filter(s=>s.kind==='static').length} region:${segments.filter(s=>s.kind==='region').length}`);

            // InstanceBegin (preserve existing reference)
            const instanceBeginMatch = instanceContent.match(/<!--\s*InstanceBegin\s+template="([^"]+)"[^>]*-->/i);
            const instanceBegin = instanceBeginMatch ? instanceBeginMatch[0] : `<!-- InstanceBegin template="/Templates/${path.basename(templatePath)}" codeOutsideHTMLIsLocked="true" -->`;

            // Remove only header InstanceBegin occurrences in static segments (avoid touching InstanceBeginRepeat)
            for (const s of segments) {
                if (s.kind === 'static') {
                    s.text = s.text.replace(/<!--\s*InstanceBegin\s+template="[^"]+"[^>]*-->\s*/gi, '');
                }
            }

            // Rebuild
            let rebuilt = '';
            let injectedInstanceBegin = false;
            const originalStaticBytes = segments.filter(s=>s.kind==='static').reduce((a,b)=>a+ (b as any).text.length,0);
            for (const s of segments) {
                if (s.kind === 'static') {
                    if (!injectedInstanceBegin) {
                        const htmlTagRegex = /<html[^>]*>/i;
                        if (htmlTagRegex.test(s.text)) {
                            rebuilt += s.text.replace(htmlTagRegex, match => `${match}\n${instanceBegin}`);
                            injectedInstanceBegin = true;
                            continue;
                        }
                    }
                    rebuilt += s.text;
                } else {
                    const name = s.region.name;
                    const preserved = preservedRegions.get(name);
                    const defaultContent = s.region.defaultContent;
                    const contentToUse = preserved !== undefined ? preserved : defaultContent;
                    if (preserved === undefined) {
                        console.log(`[DW-MERGE] Region "${name}" new (using template default)`);
                    }
                    // Preserve surrounding whitespace style: check if original full was single-line
                    const singleLine = !/\n/.test(s.region.full.trim());
                    const openTag = `<!-- InstanceBeginEditable name="${name}" -->`;
                    const closeTag = `<!-- InstanceEndEditable -->`;
                    if (singleLine) {
                        rebuilt += `${openTag}${contentToUse}${closeTag}`;
                    } else {
                        // Ensure content retains leading/trailing newlines as in preserved or default
                        let c = contentToUse;
                        rebuilt += `${openTag}${c}${closeTag}`;
                    }
                }
            }

            // Repeat block handling: transplant existing instance repeat blocks; then auto-convert leftover template repeat sections
            if (templateRepeatBlocks.size) {
                if (instanceRepeatBlocks.size) {
                    for (const [rName] of templateRepeatBlocks.entries()) {
                        const instBlock = instanceRepeatBlocks.get(rName);
                        if (instBlock) {
                            const repRe = new RegExp(`<!--\\s*TemplateBeginRepeat\\s+name=\"${rName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\"\\s*-->[\\s\\S]*?<!--\\s*TemplateEndRepeat\\s*-->`, 'i');
                            if (repRe.test(rebuilt)) {
                                rebuilt = rebuilt.replace(repRe, instBlock);
                                console.log(`[DW-MERGE] Preserved repeat block "${rName}" from instance`);
                                outputChannel.appendLine(`[DW-MERGE] Preserved repeat block "${rName}" from instance`);
                            }
                        }
                    }
                }
                // Auto-convert any remaining Template repeat wrappers (provide initial structure when instance had none)
                rebuilt = rebuilt.replace(/<!--\s*TemplateBeginRepeat\s+name="([^"]+)"\s*-->[\s\S]*?<!--\s*TemplateEndRepeat\s*-->/gi, (full, name) => {
                    let converted = full
                        .replace(/TemplateBeginRepeat/g, 'InstanceBeginRepeat')
                        .replace(/TemplateEndRepeat/g, 'InstanceEndRepeat')
                        .replace(/TemplateBeginRepeatEntry/g, 'InstanceBeginRepeatEntry')
                        .replace(/TemplateEndRepeatEntry/g, 'InstanceEndRepeatEntry');
                    // Ensure at least one repeat entry wrapper exists
                    const hasEntry = /InstanceBeginRepeatEntry/.test(converted);
                    if (!hasEntry) {
                        // Wrap inner rows (between first line after begin and before end) into a single entry
                        const m = /<!--\s*InstanceBeginRepeat\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*InstanceEndRepeat\s*-->/i.exec(converted);
                        if (m) {
                            const inner = m[2].trim();
                            const wrappedInner = `\n<!-- InstanceBeginRepeatEntry -->\n${inner}\n<!-- InstanceEndRepeatEntry -->\n`;
                            converted = converted.replace(m[0], `${m[0].replace(m[2], wrappedInner)}`);
                        }
                    }
                    return converted;
                });
            }

            // Post-processing normalization: ensure no stray TemplateEndRepeat left and each InstanceBeginRepeat has a matching InstanceEndRepeat
            try {
                // Convert any remaining TemplateEndRepeat tokens defensively
                rebuilt = rebuilt.replace(/<!--\s*TemplateEndRepeat\s*-->/gi, '<!-- InstanceEndRepeat -->');
                // For every InstanceBeginRepeat name="X" ensure a closing InstanceEndRepeat exists after its content
                const beginRepeatRe = /<!--\s*InstanceBeginRepeat\s+name="([^"]+)"\s*-->/gi;
                const requiredClosers: {name:string; index:number}[] = [];
                let br: RegExpExecArray | null;
                while ((br = beginRepeatRe.exec(rebuilt)) !== null) {
                    requiredClosers.push({ name: br[1], index: br.index });
                }
                // Simple heuristic: count closers; if fewer than begins, append missing at end of tbody or end of file
                const endRepeatCount = (rebuilt.match(/<!--\s*InstanceEndRepeat\s*-->/gi) || []).length;
                if (endRepeatCount < requiredClosers.length) {
                    const missing = requiredClosers.length - endRepeatCount;
                    // Try to insert before closing </tbody> if present else before </table> else end of file
                    let insertionPoint = rebuilt.search(/<\/tbody>/i);
                    if (insertionPoint === -1) insertionPoint = rebuilt.search(/<\/table>/i);
                    if (insertionPoint === -1) insertionPoint = rebuilt.length;
                    const insertion = '\n' + Array(missing).fill('<!-- InstanceEndRepeat -->').join('\n') + '\n';
                    rebuilt = rebuilt.slice(0, insertionPoint) + insertion + rebuilt.slice(insertionPoint);
                }
            } catch (normErr) {
                console.warn('[DW-MERGE] Repeat normalization issue:', normErr);
            }

            // Append InstanceEnd
            rebuilt = rebuilt.replace(/<!--\s*InstanceEnd\s*-->/gi, '');
            rebuilt = rebuilt.replace(/(<\/html>)/i, '<!-- InstanceEnd -->$1');

            // Idempotency cleanup
            rebuilt = rebuilt.replace(/\n{4,}/g, '\n\n');

            // Fallback injection: if some preserved regions were not present in parsed template
            // (e.g., parser missed inside complex constructs), replace any matching TemplateBeginEditable
            // blocks in rebuilt with InstanceBeginEditable and preserved content to avoid data loss.
            for (const [pName, pContent] of preservedRegions.entries()) {
                if (!templateRegionNames.has(pName) && allTemplateEditableNames.has(pName)) {
                    const blockRe = new RegExp(`<!--\\s*TemplateBeginEditable\\s+name="${pName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*-->([\\s\\S]*?)<!--\\s*TemplateEndEditable\\s*-->`, 'i');
                    if (blockRe.test(rebuilt)) {
                        rebuilt = rebuilt.replace(blockRe, `<!-- InstanceBeginEditable name="${pName}" -->${pContent}<!-- InstanceEndEditable -->`);
                        console.log(`[DW-MERGE] Fallback injected preserved region "${pName}" into rebuilt content`);
                    }
                }
            }

            // Preserve code outside <html> when codeOutsideHTMLIsLocked="false"
            try {
                const outsideLockFalse = /codeOutsideHTMLIsLocked\s*=\s*"false"/i.test(instanceBegin);
                if (outsideLockFalse) {
                    const instHtmlOpen = (() => { const m = /<html[^>]*>/i.exec(instanceContent); return m ? { idx: m.index, len: m[0].length } : null; })();
                    const instHtmlClose = (() => { let m: RegExpExecArray | null; let last: RegExpExecArray | null = null; const r = /<\/html>/ig; while ((m = r.exec(instanceContent)) !== null) last = m; return last ? { idx: last.index, len: last[0].length } : null; })();
                    const rebHtmlOpen = (() => { const m = /<html[^>]*>/i.exec(rebuilt); return m ? { idx: m.index, len: m[0].length } : null; })();
                    const rebHtmlClose = (() => { let m: RegExpExecArray | null; let last: RegExpExecArray | null = null; const r = /<\/html>/ig; while ((m = r.exec(rebuilt)) !== null) last = m; return last ? { idx: last.index, len: last[0].length } : null; })();

                    if (instHtmlOpen && rebHtmlOpen) {
                        const instancePrefix = instanceContent.slice(0, instHtmlOpen.idx);
                        // Replace prefix before <html> in rebuilt with instance prefix
                        rebuilt = instancePrefix + rebuilt.slice(rebHtmlOpen.idx);
                        console.log('[DW-MERGE] Preserved code before <html> due to codeOutsideHTMLIsLocked="false"');
                    }
                    // Preserve content after InstanceEnd; if absent, fallback to after </html>
                    const instEndExecAll = (() => { let m: RegExpExecArray | null; let last: RegExpExecArray | null = null; const r = /<!--\s*InstanceEnd\s*-->/ig; while ((m = r.exec(instanceContent)) !== null) last = m; return last; })();
                    if (instEndExecAll) {
                        const tail = instanceContent.slice(instEndExecAll.index + instEndExecAll[0].length);
                        const afterHtml = tail.replace(/^[\s\r\n]*<\/html>/i, '');
                        if (afterHtml.length > 0) {
                            rebuilt = rebuilt + afterHtml;
                            console.log('[DW-MERGE] Preserved content after InstanceEnd/</html>');
                        }
                    } else if (instHtmlClose) {
                        const afterHtmlOnly = instanceContent.slice(instHtmlClose.idx + instHtmlClose.len);
                        if (afterHtmlOnly.length > 0) {
                            rebuilt = rebuilt + afterHtmlOnly;
                            console.log('[DW-MERGE] Preserved content after </html> (no InstanceEnd found)');
                        }
                    }
                }
            } catch (e) {
                console.warn('[DW-MERGE] Failed to preserve outside-HTML code:', e);
            }

            // Final enforcement: ensure InstanceEnd and </html> exist
            const hasInstEnd = /<!--\s*InstanceEnd\s*-->/i.test(rebuilt);
            const hasHtmlClose = /<\/html>/i.test(rebuilt);
            if (!hasInstEnd && hasHtmlClose) {
                rebuilt = rebuilt.replace(/(<\/html>)/i, '<!-- InstanceEnd -->$1');
            } else if (!hasInstEnd && !hasHtmlClose) {
                rebuilt += '\n<!-- InstanceEnd --></html>';
            } else if (hasInstEnd && !hasHtmlClose) {
                rebuilt += '\n</html>';
            }
            // Normalize order: ensure InstanceEnd precedes </html>
            rebuilt = rebuilt.replace(/<\/html>\s*<!--\s*InstanceEnd\s*-->/ig, '<!-- InstanceEnd --></html>');

            // --- Alternating bgcolor enforcement (NEW) ---
            // Extract repeat template row pattern with ternary: <tr bgcolor="@@(_index & 1 ? '#FFFFFF' : '#CCCCCC')@@">
            function extractBgcolorTernary(template: string): {repeatName: string; colorA: string; colorB: string}[] {
                const results: {repeatName: string; colorA: string; colorB: string}[] = [];
                const repeatBlockRe = /<!--\s*TemplateBeginRepeat\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndRepeat\s*-->/gi;
                let rb: RegExpExecArray | null;
                while ((rb = repeatBlockRe.exec(template)) !== null) {
                    const rName = rb[1];
                    const block = rb[2];
                    const ternaryRe = /<tr[^>]*\sbgcolor="@@\(_index\s*&\s*1\s*\?\s*'([^']+)'\s*:\s*'([^']+)'\)@@"[^>]*>/i;
                    const m = ternaryRe.exec(block);
                    if (m) {
                        results.push({ repeatName: rName, colorA: m[1], colorB: m[2] });
                    }
                }
                return results;
            }

            function applyAlternatingBgColors(instanceHtml: string, patterns: {repeatName: string; colorA: string; colorB: string}[]): string {
                if (!patterns.length) return instanceHtml;
                // For each repeat with a ternary, locate its InstanceBeginRepeat block
                for (const pat of patterns) {
                    const instRepeatRe = new RegExp(`(<!--\\s*InstanceBeginRepeat\\s+name=\"${pat.repeatName.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\"\\s*-->)([\\s\\S]*?)(<!--\\s*InstanceEndRepeat\\s*-->)`, 'i');
                    const match = instRepeatRe.exec(instanceHtml);
                    if (!match) continue;
                    const before = instanceHtml.slice(0, match.index);
                    const middle = match[2];
                    const after = instanceHtml.slice(match.index + match[0].length);
                    // Split into entries
                    const entryRe = /(<!--\s*InstanceBeginRepeatEntry\s*-->)([\s\S]*?)(<!--\s*InstanceEndRepeatEntry\s*-->)/g;
                    let em: RegExpExecArray | null;
                    let rebuiltEntries = '';
                    let idx = 0;
                    while ((em = entryRe.exec(middle)) !== null) {
                        const entryFull = em[0];
                        // Replace first <tr ... bgcolor="#XXXXXX" ...> inside entry
                        const desired = (idx & 1) ? pat.colorA : pat.colorB; // pattern colorA used when index is odd per (_index & 1 ? colorA : colorB)
                        const swapped = entryFull.replace(/(<tr[^>]*\sbgcolor=")(#?[A-Fa-f0-9]{3,6})("[^>]*>)/, (full, p1, _old, p3) => {
                            return `${p1}${desired}${p3}`;
                        });
                        rebuiltEntries += swapped;
                        idx++;
                    }
                    if (rebuiltEntries) {
                        const newBlock = match[1] + rebuiltEntries + match[3];
                        instanceHtml = before + newBlock + after;
                    }
                }
                return instanceHtml;
            }

            const ternaryPatterns = extractBgcolorTernary(templateContent);
            if (ternaryPatterns.length) {
                const beforeColorFix = rebuilt;
                rebuilt = applyAlternatingBgColors(rebuilt, ternaryPatterns);
                if (beforeColorFix !== rebuilt) {
                    console.log(`[DW-MERGE] Applied alternating bgcolor logic for repeats: ${ternaryPatterns.map(p=>p.repeatName).join(', ')}`);
                }
            }
            // --- End alternating bgcolor enforcement ---

            // Safety guard: comprehensive validation
            const safetyIssues: string[] = [];
            // A) Check that preserved region presence isn't lost
            for (const [rName, rContent] of preservedRegions.entries()) {
                if (!allTemplateEditableNames.has(rName)) continue;
                if (namesInsideRepeat.has(rName)) {
                    const hasRegion = new RegExp(`<!--\\s*InstanceBeginEditable\\s+name=\"${rName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\"`, 'i').test(rebuilt);
                    if (!hasRegion) safetyIssues.push(`Missing repeat editable region: "${rName}"`);
                } else {
                    const trimmed = rContent.trim();
                    const snippet = trimmed.slice(0, Math.min(40, trimmed.length));
                    if (snippet && !rebuilt.includes(snippet)) safetyIssues.push(`Lost content for region: "${rName}"`);
                }
            }
            // B) Region count should not decrease
            const countOcc = (content: string, name: string): number => {
                const re = new RegExp(`<!--\\s*InstanceBeginEditable\\s+name=\"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\"`, 'gi');
                return (content.match(re) || []).length;
            };
            for (const name of allTemplateEditableNames) {
                const instCount = countOcc(instanceContent, name);
                const rebCount = countOcc(rebuilt, name);
                if (instCount > 0 && rebCount < instCount) {
                    safetyIssues.push(`Region "${name}": count decreased (${rebCount} < ${instCount})`);
                }
            }
            // C) Repeat integrity: no template repeat tokens should remain after auto-conversion
            if (/<!--\s*Template(Begin|End)Repeat/.test(rebuilt)) {
                safetyIssues.push('Template repeat markers remained in output (post-conversion)');
            }
            for (const rn of Array.from(templateRepeatBlocks.keys())) {
                const instHas = new RegExp(`<!--\\s*InstanceBeginRepeat\\s+name=\"${rn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\"`, 'i').test(instanceContent);
                if (instHas) {
                    const rebuiltHasBegin = new RegExp(`<!--\\s*InstanceBeginRepeat\\s+name=\"${rn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\"`, 'i').test(rebuilt);
                    const rebuiltHasEnd = /<!--\s*InstanceEndRepeat\s*-->/i.test(rebuilt);
                    if (!rebuiltHasBegin || !rebuiltHasEnd) {
                        safetyIssues.push(`Repeat "${rn}": missing InstanceBeginRepeat/InstanceEndRepeat`);
                    }
                }
            }

            if (rebuilt !== instanceContent) {
                // D) Size & static shrink checks
                const ratio = rebuilt.length / Math.max(1, instanceContent.length);
                if (instanceContent.length > 500 && ratio < 0.4) {
                    safetyIssues.push(`Rebuilt size ratio too small (${ratio.toFixed(2)})`);
                }
                const rebuiltStaticBytes = rebuilt.replace(/<!--\s*InstanceBeginEditable[\s\S]*?InstanceEndEditable\s*-->/g,'').length;
                if (rebuiltStaticBytes < originalStaticBytes * 0.5) {
                    safetyIssues.push(`Static content reduced significantly (${rebuiltStaticBytes} < ${Math.round(originalStaticBytes * 0.5)})`);
                }

                if (safetyIssues.length) {
                    const details = `Safety checks failed for ${path.basename(instancePath)}:\n- ${safetyIssues.join('\n- ')}`;
                    console.warn(`[DW-MERGE] ${details}`);
                    outputChannel.appendLine(details);
                    const NEXT = 'Next File';
                    const SHOW = 'Show Error';
                    const decision = await vscode.window.showWarningMessage(
                        `Safety checks flagged ${path.basename(instancePath)}.`,
                        { modal: true },
                        NEXT, SHOW
                    );
                    if (decision === SHOW) {
                        try {
                            const siteRoot = path.dirname(path.dirname(templatePath));
                            const tempDir = path.join(siteRoot, '.dwt-template-protection-temp');
                            fs.mkdirSync(tempDir, { recursive: true });
                            const tempPath = path.join(tempDir, path.basename(instancePath));
                            fs.writeFileSync(tempPath, rebuilt, 'utf8');
                            await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(instancePath), vscode.Uri.file(tempPath), `Safety: ${path.basename(instancePath)}`);
                        } catch (e) {
                            vscode.window.showErrorMessage('Failed to show safety diff.');
                        }
                        // Secondary popup (show error popup)
                        const NEXT2 = 'Next File';
                        const decision2 = await vscode.window.showWarningMessage(
                            `Review safety diff for ${path.basename(instancePath)}.`,
                            { modal: true },
                            NEXT2
                        );
                        if (decision2 === undefined) {
                            // treat close as Next File (skip)
                        }
                        logProcessCompletion('updateHtmlLikeDreamweaver:item-safety-diff-shown', 4);
                        return { status: 'safetyFailed' }; // Skip editing
                    }
                    if (decision === NEXT) {
                        logProcessCompletion('updateHtmlLikeDreamweaver:item-safety-skip', 4);
                        return { status: 'safetyFailed' };
                    }
                    if (decision === undefined) { // user cancelled (native Cancel)
                        cancelRunForRun = true;
                        logProcessCompletion('updateHtmlLikeDreamweaver:run-cancelled', 2);
                        return { status: 'cancelled' };
                    }
                    // Any other outcome (should not happen) treat as skip
                    logProcessCompletion('updateHtmlLikeDreamweaver:item-safety-skip', 4);
                    return { status: 'safetyFailed' };
                }

                // --- Update Popup for passing safety ---
                let wrote = false;
                if (applyToAllForRun) {
                    fs.writeFileSync(instancePath, rebuilt, 'utf8');
                    wrote = true;
                } else {
                    const APPLY = 'Apply';
                    const APPLY_ALL = 'Apply to All';
                    const SHOW_DIFF = 'Show Diff';
                    const SKIP = 'Skip';
                    let decision: string | undefined = await vscode.window.showInformationMessage(
                        `Update '${path.basename(instancePath)}' with template changes?`,
                        { modal: true },
                        APPLY, APPLY_ALL, SHOW_DIFF, SKIP
                    );
                    if (decision === SHOW_DIFF) {
                        // Prepare temp file for diff
                        try {
                            const siteRoot = path.dirname(path.dirname(templatePath));
                            const tempDir = path.join(siteRoot, '.dwt-template-protection-temp');
                            fs.mkdirSync(tempDir, { recursive: true });
                            const tempPath = path.join(tempDir, path.basename(instancePath));
                            fs.writeFileSync(tempPath, rebuilt, 'utf8');
                            await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(instancePath), vscode.Uri.file(tempPath), `Diff: ${path.basename(instancePath)}`);
                        } catch (e) {
                            vscode.window.showErrorMessage('Failed to show diff.');
                        }
                        // secondary popup after diff
                        decision = await vscode.window.showInformationMessage(
                            `Apply template changes to '${path.basename(instancePath)}'?`,
                            { modal: true },
                            APPLY, APPLY_ALL, SKIP
                        );
                    }
                    if (decision === APPLY_ALL) {
                        applyToAllForRun = true;
                        fs.writeFileSync(instancePath, rebuilt, 'utf8');
                        wrote = true;
                    } else if (decision === APPLY) {
                        fs.writeFileSync(instancePath, rebuilt, 'utf8');
                        wrote = true;
                    } else if (decision === SKIP) {
                        logProcessCompletion('updateHtmlLikeDreamweaver:item-skipped', 3);
                        return { status: 'skipped' };
                    } else if (decision === undefined) { // user pressed native Cancel (X) in modal
                        cancelRunForRun = true;
                        logProcessCompletion('updateHtmlLikeDreamweaver:run-cancelled', 2);
                        return { status: 'cancelled' };
                    } else { // SKIP or unexpected label
                        logProcessCompletion('updateHtmlLikeDreamweaver:item-skipped', 3);
                        return { status: 'skipped' };
                    }
                }
                if (wrote) {
                    console.log(`[DW-MERGE] Wrote updated instance: ${instancePath}`);
                    outputChannel.appendLine(`[DW-MERGE] Wrote updated instance: ${instancePath}`);
                }
            } else {
                console.log('[DW-MERGE] No changes needed (already up to date)');
                outputChannel.appendLine('[DW-MERGE] No changes needed (already up to date)');
            }
            logProcessCompletion('updateHtmlLikeDreamweaver:item-updated');
            return { status: 'updated' };
        } catch (e) {
            console.error(`[DW-MERGE] Failed merging instance ${instanceUri.fsPath}:`, e);
            logProcessCompletion('updateHtmlLikeDreamweaver:item-error', 1);
            return { status: 'error' };
        }
    }

    async function updateHtmlBasedOnTemplate(templateUri: vscode.Uri): Promise<void> {
        if (!isTemplateSyncEnabled) {
            return;
        }

        // Show progress with cancel option
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Updating HTML based on template (preserving content)",
            cancellable: true
        }, async (progress, token) => {
            try {
                console.log(`Starting Dreamweaver-style update for template: ${templateUri.fsPath}`);
                
                // Check for cancellation
                if (token.isCancellationRequested) {
                    return;
                }
                
                progress.report({ increment: 10, message: "Finding template instances..." });
                
                // Step 1: Find ONLY HTML instances of THIS template (not child templates)
                const instances = await findTemplateInstances(templateUri.fsPath);
                
                // Step 2: Find child templates separately (these will be updated differently)
                const childTemplates = await findChildTemplates(templateUri.fsPath);
                
                // Check for cancellation
                if (token.isCancellationRequested) {
                    return;
                }
                
                progress.report({ increment: 20, message: `Found ${instances.length} HTML/PHP instances and ${childTemplates.length} child templates` });
                
                // If no instances found, show message
                if (instances.length === 0) {
                    const templateDir = path.dirname(templateUri.fsPath);
                    const templateDirName = path.basename(templateDir);
                    
                    let message = `No HTML instance files found for template ${path.basename(templateUri.fsPath)}`;
                    if (templateDirName !== 'Templates') {
                        message += `\n\nNote: Template must be in a folder named "Templates" for instance detection to work. Current folder: "${templateDirName}"`;
                    }
                    
                    // Still update child templates even if no HTML instances
                    if (childTemplates.length > 0) {
                        message += `\n\nFound ${childTemplates.length} child template(s) that will be updated.`;
                    }
                    
                    vscode.window.showInformationMessage(message);
                    
                    // We may still proceed if child templates exist
                }

                // Temporarily disable protection during update
                const originalProtectionState = isProtectionEnabled;
                isProtectionEnabled = false;
                
                const templateContent = fs.readFileSync(templateUri.fsPath, 'utf8');
                
                // Check for cancellation
                if (token.isCancellationRequested) {
                    isProtectionEnabled = originalProtectionState;
                    return;
                }

                // Create backups (instances + child templates), preserving structure
                const toBackupMap = new Map<string, vscode.Uri>();
                for (const u of instances) toBackupMap.set(u.fsPath, u);
                for (const u of childTemplates) toBackupMap.set(u.fsPath, u);
                const toBackup = Array.from(toBackupMap.values());
                if (toBackup.length > 0) {
                    progress.report({ increment: 10, message: `Creating backups of ${toBackup.length} file(s)...` });
                    try {
                        const backupDir = await createHtmlBackups(toBackup, templateUri.fsPath);
                        vscode.window.showInformationMessage(
                            `Backed up ${toBackup.length} file(s) to: ${path.basename(backupDir)}`
                        );
                    } catch (error) {
                        console.error('Backup creation failed:', error);
                        vscode.window.showErrorMessage(
                            `Failed to create backups: ${error instanceof Error ? error.message : String(error)}. Proceeding without backup.`
                        );
                    }
                }
                
                // Step 3: Update child templates (but NOT their instances automatically)
                if (childTemplates.length > 0) {
                    console.log(`Found ${childTemplates.length} child templates to update`);
                    progress.report({ increment: 15, message: `Updating ${childTemplates.length} child templates...` });
                    
                    for (let i = 0; i < childTemplates.length; i++) {
                        // Check for cancellation
                        if (token.isCancellationRequested) {
                            isProtectionEnabled = originalProtectionState;
                            return;
                        }
                        
                        const childTemplate = childTemplates[i];
                        try {
                            // Update the child template based on the parent template
                            await updateTemplateBasedOnTemplate(childTemplate, templateUri.fsPath);
                            console.log(`Updated child template: ${childTemplate.fsPath}`);
                            
                            progress.report({ increment: 15 / childTemplates.length, message: `Updated child template ${i + 1}/${childTemplates.length}` });
                        } catch (error) {
                            console.error(`Error updating child template ${childTemplate.fsPath}:`, error);
                        }
                    }
                }
                
                // Step 4: Update HTML/PHP instances of THIS template only
                if (instances.length > 0) {
                    console.log(`Found ${instances.length} instances to update`);

                // Check for cancellation
                if (token.isCancellationRequested) {
                    isProtectionEnabled = originalProtectionState;
                    return;
                }

                progress.report({ increment: 10, message: "Preparing instance files for update..." });

                // Close all open editors for instance files to avoid conflicts
                console.log('Closing open editors for instance files...');
                for (const instanceUri of instances) {
                    const openEditor = vscode.window.visibleTextEditors.find(
                        editor => editor.document.uri.fsPath === instanceUri.fsPath
                    );
                    if (openEditor) {
                        console.log(`Found open editor for: ${instanceUri.fsPath}`);
                        // Save any unsaved changes first
                        if (openEditor.document.isDirty) {
                            console.log(`Saving unsaved changes for: ${instanceUri.fsPath}`);
                            await openEditor.document.save();
                        }
                    }
                }
                
                // Clear document snapshots to avoid conflicts
                documentSnapshots.clear();
                
                // Check for cancellation
                if (token.isCancellationRequested) {
                    isProtectionEnabled = originalProtectionState;
                    return;
                }
                
    // Check for cancellation
                    if (token.isCancellationRequested) {
                        isProtectionEnabled = originalProtectionState;
                        return;
                    }

                    progress.report({ increment: 10, message: "Preparing HTML files for update..." });

                    // Close all open editors for instance files to avoid conflicts
                    console.log('Closing open editors for instance files...');
                    for (const instanceUri of instances) {
                        const openEditor = vscode.window.visibleTextEditors.find(
                            editor => editor.document.uri.fsPath === instanceUri.fsPath
                        );
                        if (openEditor) {
                            console.log(`Found open editor for: ${instanceUri.fsPath}`);
                            // Save any unsaved changes first
                            if (openEditor.document.isDirty) {
                                console.log(`Saving unsaved changes for: ${instanceUri.fsPath}`);
                                await openEditor.document.save();
                            }
                        }
                    }
                    
                    // Clear document snapshots to avoid conflicts
                    documentSnapshots.clear();
                    
                    // Check for cancellation
                    if (token.isCancellationRequested) {
                        isProtectionEnabled = originalProtectionState;
                        return;
                    }
                    
                    // Update HTML files
                    console.log('Starting instance file updates...');
                    progress.report({ increment: 10, message: `Updating ${instances.length} file(s)...` });
                    
                    // Process sequentially so 'Apply to All' affects the whole run
                    applyToAllForRun = false; // reset
                    previewModeForRun = false; // reset
                    cancelRunForRun = false; // reset
                    const results: MergeResult[] = [];
                    for (let i = 0; i < instances.length; i++) {
                        if (token.isCancellationRequested) {
                            results.push({ status: 'cancelled' });
                            break;
                        }
                        const instanceUri = instances[i];
                        if (cancelRunForRun) {
                            results.push({ status: 'cancelled' });
                            break;
                        }
                        const result = await updateHtmlLikeDreamweaver(instanceUri, templateUri.fsPath);
                        if (cancelRunForRun) {
                            results.push(result);
                            break;
                        }
                        results.push(result);
                        progress.report({ increment: 25 / instances.length, message: `Preserved content in ${i + 1}/${instances.length}` });
                    }
                    
                    // Check if operation was cancelled
                    if (token.isCancellationRequested) {
                        isProtectionEnabled = originalProtectionState;
                        vscode.window.showWarningMessage('Template update was cancelled.');
                        return;
                    }
                    
                    // Determine success/failure counts
                    const successCount = results.filter(r => r.status === 'updated' || r.status === 'unchanged').length;
                    const safetyFailCount = results.filter(r => r.status === 'safetyFailed').length;
                    const errorCount = results.filter(r => r.status === 'error').length;
                    const skippedCount = results.filter(r => r.status === 'skipped').length;
                    const totalProcessed = results.length;
                    // (processSafetyCheckPass removed) Always show final completion popup later regardless
                    
                    let message = `Updated ${successCount} HTML file(s) while preserving editable content`;
                    if (childTemplates.length > 0) {
                        message += ` and ${childTemplates.length} child template(s)`;
                    }
                    message += ` based on template ${path.basename(templateUri.fsPath)}`;
                    
                    if (cancelRunForRun) {
                        vscode.window.showWarningMessage('Template update was cancelled. Some files may not be updated.');
                    } else {
                        // Show summary only if all safety checks passed OR there were updates; final failed safety popup handled below
                        vscode.window.showInformationMessage(`${message} (Safety failures: ${safetyFailCount}, Errors: ${errorCount}, Skipped: ${skippedCount})`);
                    }
                } else {
                    // Only child templates were updated
                    if (childTemplates.length > 0) {
                        vscode.window.showInformationMessage(
                            `Updated ${childTemplates.length} child template(s) based on template ${path.basename(templateUri.fsPath)}`
                        );
                    }
                }
                
                // Re-enable protection
                isProtectionEnabled = originalProtectionState;
                
                // Refresh decorations for any open editors
                if (vscode.window.activeTextEditor) {
                    updateDecorations(vscode.window.activeTextEditor);
                }
                
                // Always show final completion popup
                if (!cancelRunForRun) {
                    // Single-button completion notice (no Cancel)
                    await vscode.window.showInformationMessage('The process of "Updating HTML Files Based on Template" is complete.', { modal: true });
                }
                if (cancelRunForRun) logProcessCompletion('updateHtmlBasedOnTemplate:cancelled', 2); else logProcessCompletion('updateHtmlBasedOnTemplate');
            } catch (error) {
                console.error('Error during template update:', error);
                vscode.window.showErrorMessage(`Template update failed: ${error instanceof Error ? error.message : String(error)}`);
                logProcessCompletion('updateHtmlBasedOnTemplate', 1);
            }
        });
    }

    function setupTemplateWatcher(): void {
        if (templateWatcher) {
            templateWatcher.dispose();
        }

        // Watch for changes to .dwt files
        templateWatcher = vscode.workspace.createFileSystemWatcher('**/*.dwt');
        
        templateWatcher.onDidChange(async (uri) => {
            // Remove auto-sync - only sync when explicitly requested via right-click command
            vscode.window.showInformationMessage(
                `Template updated: ${path.basename(uri.fsPath)}. Right-click and select "Update HTML Based on Template" to update instances.`
            );
        });
        
        templateWatcher.onDidCreate(async (uri) => {
            vscode.window.showInformationMessage(
                `New Dreamweaver template created: ${path.basename(uri.fsPath)}`
            );
        });
    }

    const changeListener = vscode.workspace.onDidChangeTextDocument(async event => {
        if (isProcessingUndo || isRestoringContent) return;

        const editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor.document && isProtectionEnabled) {
            // Allow full editing of .dwt template files
            if (isDreamweaverTemplateFile(editor.document)) {
                return;
            }

            // Only protect instance files from editing protected regions
            if (!shouldProtectFromEditing(editor.document)) {
                return;
            }

            const protectedRanges = getProtectedRanges(editor.document);

            for (const change of event.contentChanges) {
                if (
                    isProtectedRegionChange(change, protectedRanges, editor.document)
                ) {
                    console.log('Protected region change detected, restoring from snapshot');
                    await restoreFromSnapshot(editor);
                    vscode.window.showWarningMessage('You cannot edit protected regions in Dreamweaver templates.');
                    break;
                }
            }

            // Update snapshot after processing changes
            if (shouldProtectFromEditing(editor.document)) {
                saveDocumentSnapshot(editor.document);
            }
        }
    });

    const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(editor => {
        updateDecorations(editor);
        if (editor && shouldProtectFromEditing(editor.document)) {
            saveDocumentSnapshot(editor.document);
        }
    });

    const documentOpenListener = vscode.workspace.onDidOpenTextDocument(document => {
        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document === document) {
            updateDecorations(vscode.window.activeTextEditor);
            if (shouldProtectFromEditing(document)) {
                saveDocumentSnapshot(document);
            }
        }
    });

    const showEditableRegionsCommand = vscode.commands.registerCommand('dreamweaverTemplate.showEditableRegions', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && (isDreamweaverTemplate(editor.document) || isDreamweaverTemplateFile(editor.document))) {
            showEditableRegionsList(editor.document);
        } else {
            vscode.window.showInformationMessage('This command only works in Dreamweaver template files.');
        }
    });

    const toggleProtectionCommand = vscode.commands.registerCommand('dreamweaverTemplate.toggleProtection', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && (isDreamweaverTemplate(editor.document) || isDreamweaverTemplateFile(editor.document))) {
            isProtectionEnabled = !isProtectionEnabled;
            vscode.window.showInformationMessage(
                `Dreamweaver template protection ${isProtectionEnabled ? 'enabled' : 'disabled'}.`
            );
            updateDecorations(editor);
        }
    });

    const syncTemplateCommand = vscode.commands.registerCommand('dreamweaverTemplate.syncTemplate', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor. Open a .dwt template file.');
            logProcessCompletion('syncTemplate:no-editor', 3);
            return;
        }
        if (!ensureWorkspaceContext(editor.document.uri)) return;
        if (editor.document.fileName.toLowerCase().endsWith('.dwt')) {
            const templateName = path.basename(editor.document.fileName);
            const choice = await vscode.window.showWarningMessage(
                `Are you sure you want to update HTML based on template "${templateName}"?\n\nThis will update the template structure while preserving all editable content.`,
                { modal: true },
                'Yes',
                'No'
            );
            if (choice === 'Yes') {
                await updateHtmlBasedOnTemplate(editor.document.uri);
                if (cancelRunForRun) logProcessCompletion('syncTemplate:cancelled', 2); else logProcessCompletion('syncTemplate');
            }
        } else {
            vscode.window.showErrorMessage('This command only works on Dreamweaver template (.dwt) files.');
            logProcessCompletion('syncTemplate:not-template', 3);
        }
    });

    const restoreBackupCommand = vscode.commands.registerCommand('dreamweaverTemplate.restoreBackup', async () => {
        // Check if backup info exists first
        if (!lastBackupInfo) {
            vscode.window.showErrorMessage('No backup information found. Cannot restore files.');
            logProcessCompletion('restoreBackup:no-backup', 1);
            return;
        }
        if (!ensureWorkspaceContext()) return;
        
        // Show confirmation dialog with template name
        const templateName = lastBackupInfo.templateName;
        const fileCount = lastBackupInfo.instances.length;
        const choice = await vscode.window.showWarningMessage(
            `Are you sure you want to restore the last backup for template "${templateName}"?\n\nThis will restore ${fileCount} HTML file(s) from the most recent backup and overwrite current content.`,
            { modal: true },
            'Yes',
            'No'
        );
        
        if (choice === 'Yes') {
            await restoreHtmlFromBackup();
            logProcessCompletion('restoreBackup');
        }
    });

    const toggleTemplateSyncCommand = vscode.commands.registerCommand('dreamweaverTemplate.toggleTemplateSync', () => {
        isTemplateSyncEnabled = !isTemplateSyncEnabled;
        vscode.window.showInformationMessage(
            `Template synchronization ${isTemplateSyncEnabled ? 'enabled' : 'disabled'}.`
        );
    });

    const findInstancesCommand = vscode.commands.registerCommand('dreamweaverTemplate.findInstances', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor. Open a .dwt template file.');
            logProcessCompletion('findInstances:no-editor', 3);
            return;
        }
        if (!ensureWorkspaceContext(editor.document.uri)) return;
        if (editor.document.fileName.toLowerCase().endsWith('.dwt')) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Finding template instances',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Scanning workspace...' });
                const instances = await findTemplateInstances(editor.document.uri.fsPath);
                progress.report({ message: `Found ${instances.length} instance(s)`, increment: 100 });
                if (instances.length > 0) {
                    const instanceNames = instances.map(uri => path.basename(uri.fsPath));
                    vscode.window.showQuickPick(instanceNames, {
                        placeHolder: `Found ${instances.length} instance(s). Select one to open:`
                    }).then(selectedInstance => {
                        if (selectedInstance) {
                            const selectedUri = instances.find(uri => path.basename(uri.fsPath) === selectedInstance);
                            if (selectedUri) {
                                vscode.window.showTextDocument(selectedUri);
                            }
                        }
                        logProcessCompletion('findInstances');
                    });
                } else {
                    vscode.window.showInformationMessage('No instances found for this template.');
                    logProcessCompletion('findInstances:empty', 0);
                }
            });
        } else {
            vscode.window.showErrorMessage('This command only works on Dreamweaver template (.dwt) files.');
            logProcessCompletion('findInstances:not-template', 3);
        }
    });

    // Helper function to find repeat block containing cursor position
    function findRepeatBlockAtCursor(document: vscode.TextDocument, position: vscode.Position): { repeatName: string; firstEntry: string; entryStart: number; entryEnd: number } | null {
        const text = document.getText();
        const cursorOffset = document.offsetAt(position);
        
        // Find all repeat blocks in document
        const repeatBlockRegex = /<!--\s*InstanceBeginRepeat\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*InstanceEndRepeat\s*-->/g;
        let repeatMatch;
        
        while ((repeatMatch = repeatBlockRegex.exec(text)) !== null) {
            const repeatName = repeatMatch[1];
            const repeatContent = repeatMatch[2];
            const repeatStart = repeatMatch.index;
            const repeatEnd = repeatStart + repeatMatch[0].length;
            
            // Check if cursor is within this repeat block
            if (cursorOffset >= repeatStart && cursorOffset <= repeatEnd) {
                // Find all repeat entries within this block
                const entryRegex = /<!--\s*InstanceBeginRepeatEntry\s*-->([\s\S]*?)<!--\s*InstanceEndRepeatEntry\s*-->/g;
                let entryMatch;
                let firstEntryContent = '';
                
                while ((entryMatch = entryRegex.exec(repeatContent)) !== null) {
                    const entryStart = repeatStart + repeatMatch[0].indexOf(repeatContent) + entryMatch.index;
                    const entryEnd = entryStart + entryMatch[0].length;
                    
                    // Check if cursor is within a repeat entry
                    if (cursorOffset >= entryStart && cursorOffset <= entryEnd) {
                        // Capture first entry content if not already captured
                        if (!firstEntryContent) {
                            firstEntryContent = entryMatch[0]; // Include the full entry with markers
                        }
                        
                        return {
                            repeatName,
                            firstEntry: firstEntryContent,
                            entryStart,
                            entryEnd
                        };
                    }
                }
            }
        }
        
        return null;
    }

    // Normalize alternating row colors for a repeat if template defines ternary bgcolor pattern
    async function normalizeRepeatColorsIfNeeded(document: vscode.TextDocument, repeatName: string): Promise<void> {
        try {
            const full = document.getText();
            const instBegin = /<!--\s*InstanceBegin\s+template="([^"]+)"[^>]*-->/i.exec(full);
            if (!instBegin) return;
            const templateRel = instBegin[1];
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) return;
            const templateFsPath = path.join(ws.uri.fsPath, templateRel.replace(/^\//, ''));
            if (!fs.existsSync(templateFsPath)) return;
            const templateText = fs.readFileSync(templateFsPath, 'utf8');
            const repeatBlockRe = new RegExp(`<!--\\s*TemplateBeginRepeat\\s+name=\"${repeatName.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\"\\s*-->[\\s\\S]*?<!--\\s*TemplateEndRepeat\\s*-->`,'i');
            const tmplRepeat = repeatBlockRe.exec(templateText);
            if (!tmplRepeat) return;
            const ternaryRe = /<tr[^>]*\sbgcolor="@@\(_index\s*&\s*1\s*\?\s*'([^']+)'\s*:\s*'([^']+)'\)@@"[^>]*>/i;
            const ternaryMatch = ternaryRe.exec(tmplRepeat[0]);
            if (!ternaryMatch) return;
            const colorA = ternaryMatch[1];
            const colorB = ternaryMatch[2];
            const instRepeatRe = new RegExp(`(<!--\\s*InstanceBeginRepeat\\s+name=\"${repeatName.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\"\\s*-->)([\\s\\S]*?)(<!--\\s*InstanceEndRepeat\\s*-->)`,'i');
            const instMatch = instRepeatRe.exec(full);
            if (!instMatch) return;
            const before = full.slice(0, instMatch.index);
            const middle = instMatch[2];
            const after = full.slice(instMatch.index + instMatch[0].length);
            const entryRe = /(<!--\s*InstanceBeginRepeatEntry\s*-->)([\s\S]*?)(<!--\s*InstanceEndRepeatEntry\s*-->)/g;
            let em: RegExpExecArray | null;
            let rebuiltEntries = '';
            let idx = 0;
            while ((em = entryRe.exec(middle)) !== null) {
                const entryFull = em[0];
                const desired = (idx & 1) ? colorA : colorB; // semantics: _index & 1 ? colorA : colorB
                const swapped = entryFull.replace(/(<tr[^>]*\sbgcolor=")(#?[A-Fa-f0-9]{3,6})("[^>]*>)/, (full, p1, _old, p3) => `${p1}${desired}${p3}`);
                rebuiltEntries += swapped;
                idx++;
            }
            if (!rebuiltEntries) return;
            const newBlock = instMatch[1] + rebuiltEntries + instMatch[3];
            const updated = before + newBlock + after;
            if (updated !== full) {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(full.length)), updated);
                await vscode.workspace.applyEdit(edit);
                outputChannel.appendLine(`[REPEAT-ALT] Normalized alternating bg colors for repeat "${repeatName}" (${colorA}/${colorB}).`);
            }
        } catch (e) {
            console.warn('normalizeRepeatColorsIfNeeded failed:', e);
        }
    }

    // Insert repeat entry after selection
    const insertRepeatEntryAfterCommand = vscode.commands.registerCommand('dreamweaverTemplate.insertRepeatEntryAfter', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor.');
            return;
        }
        
        const position = editor.selection.active;
        const repeatBlock = findRepeatBlockAtCursor(editor.document, position);
        
        if (!repeatBlock) {
            vscode.window.showWarningMessage('Cursor must be within a repeat entry block (between InstanceBeginRepeatEntry and InstanceEndRepeatEntry).');
            return;
        }
        
        const insertPosition = editor.document.positionAt(repeatBlock.entryEnd);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(editor.document.uri, insertPosition, '\n' + repeatBlock.firstEntry);
        
        await vscode.workspace.applyEdit(edit);

        // Normalize alternating colors if template defines a ternary for this repeat
        await normalizeRepeatColorsIfNeeded(editor.document, repeatBlock.repeatName);
        vscode.window.showInformationMessage(`Inserted repeat entry after selection in "${repeatBlock.repeatName}"`);
        
        outputChannel.appendLine(`[REPEAT-INSERT] Added entry after selection in repeat "${repeatBlock.repeatName}"`);
        logProcessCompletion('insertRepeatEntryAfter');
    });

    // Insert repeat entry before selection  
    const insertRepeatEntryBeforeCommand = vscode.commands.registerCommand('dreamweaverTemplate.insertRepeatEntryBefore', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor.');
            return;
        }
        
        const position = editor.selection.active;
        const repeatBlock = findRepeatBlockAtCursor(editor.document, position);
        
        if (!repeatBlock) {
            vscode.window.showWarningMessage('Cursor must be within a repeat entry block (between InstanceBeginRepeatEntry and InstanceEndRepeatEntry).');
            return;
        }
        
        const insertPosition = editor.document.positionAt(repeatBlock.entryStart);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(editor.document.uri, insertPosition, repeatBlock.firstEntry + '\n');
        
        await vscode.workspace.applyEdit(edit);

        // Normalize alternating colors if template defines a ternary for this repeat
        await normalizeRepeatColorsIfNeeded(editor.document, repeatBlock.repeatName);
        vscode.window.showInformationMessage(`Inserted repeat entry before selection in "${repeatBlock.repeatName}"`);
        
        outputChannel.appendLine(`[REPEAT-INSERT] Added entry before selection in repeat "${repeatBlock.repeatName}"`);
        logProcessCompletion('insertRepeatEntryBefore');
    });

    // Initialize template watcher
    setupTemplateWatcher();

    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
        if (shouldProtectFromEditing(vscode.window.activeTextEditor.document)) {
            saveDocumentSnapshot(vscode.window.activeTextEditor.document);
        }
    }

    // Protection toggle commands
    const turnOffProtectionCommand = vscode.commands.registerCommand('dreamweaverTemplate.turnOffProtection', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor to modify protection for.');
            return;
        }
        if (!isDreamweaverTemplate(editor.document) || isDreamweaverTemplateFile(editor.document)) {
            vscode.window.showInformationMessage('Protection settings only apply to Dreamweaver template instance files (.html/.php with template comments).');
            return;
        }
        setFileProtectionState(editor.document, false);
        updateDecorations(editor);
        vscode.window.showInformationMessage(`Protection turned OFF for ${path.basename(editor.document.fileName)}`);
    });

    const turnOnProtectionCommand = vscode.commands.registerCommand('dreamweaverTemplate.turnOnProtection', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor to modify protection for.');
            return;
        }
        if (!isDreamweaverTemplate(editor.document) || isDreamweaverTemplateFile(editor.document)) {
            vscode.window.showInformationMessage('Protection settings only apply to Dreamweaver template instance files (.html/.php with template comments).');
            return;
        }
        setFileProtectionState(editor.document, true);
        updateDecorations(editor);
        vscode.window.showInformationMessage(`Protection turned ON for ${path.basename(editor.document.fileName)}`);
    });

    // Create New Page from Template command
    const createPageFromTemplateCommand = vscode.commands.registerCommand('dreamweaverTemplate.createPageFromTemplate', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.toLowerCase().endsWith('.dwt')) {
            vscode.window.showWarningMessage('Open a .dwt template to create a page.');
            return;
        }
        const templatePath = editor.document.uri.fsPath;
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) {
            vscode.window.showErrorMessage('Workspace folder required.');
            return;
        }
        // Determine site root dynamically: assume .dwt is inside a "Templates" folder that sits under site root
        const templateDir = path.dirname(templatePath);
        const basename = path.basename(templateDir).toLowerCase();
        let siteRoot: string;
        if (basename === 'templates') {
            siteRoot = path.dirname(templateDir);
        } else {
            // Fallback: search upward for a Templates folder sibling containing this template (unlikely path)
            let current = templateDir;
            let found: string | undefined;
            for (let i=0;i<6;i++) { // limit ascent to avoid runaway
                const candidate = path.join(current, 'Templates');
                if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                    if (fs.existsSync(path.join(candidate, path.basename(templatePath)))) {
                        found = current;
                        break;
                    }
                }
                const parent = path.dirname(current);
                if (parent === current) break;
                current = parent;
            }
            if (found) {
                siteRoot = found;
            } else {
                vscode.window.showErrorMessage('Unable to determine site root (expected template in a "Templates" folder).');
                return;
            }
        }

        // Build folder tree structure
        interface FolderNode { name: string; fullPath: string; children: FolderNode[]; }
        function readFolders(dir: string): FolderNode {
            const node: FolderNode = { name: path.basename(dir), fullPath: dir, children: [] };
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const e of entries) {
                    if (e.isDirectory()) {
                        const fullChild = path.join(dir, e.name);
                        const lower = e.name.toLowerCase();
                        // Skip Templates root itself for destination + skip internal metadata folders
                        if (lower === 'templates' && fullChild === path.join(siteRoot, 'Templates')) continue;
                        if (lower.startsWith('.dwt-template') || lower.startsWith('.dwt-site-template')) continue;
                        node.children.push(readFolders(fullChild));
                    }
                }
                node.children.sort((a,b)=> a.name.localeCompare(b.name));
            } catch {}
            return node;
        }
        const tree = readFolders(siteRoot);

        // Serialize tree to send to webview
        function flatten(node: FolderNode, depth = 0): any[] {
            const rel = path.relative(siteRoot, node.fullPath).replace(/\\/g,'/');
            // Root node should display actual site root folder name (request)
            const rootName = path.basename(siteRoot);
            const display = (depth===0? rootName : node.name);
            const arr = [{ name: node.name, display, fullPath: node.fullPath, rel: rel || '.', depth, children: node.children.length>0 }];
            for (const c of node.children) arr.push(...flatten(c, depth+1));
            return arr;
        }
        const flat = flatten(tree);

        // Create panel
        const panel = vscode.window.createWebviewPanel(
            'createPageFromTemplate',
            'Create New Page from Template',
            vscode.ViewColumn.Active,
            { enableScripts: true }
        );

        const nonce = Date.now().toString();
        panel.webview.html = getCreatePageHtml(flat, nonce);

        panel.webview.onDidReceiveMessage(async msg => {
            if (msg.type === 'validateName') {
                const targetPath = path.join(siteRoot, msg.relPath === '.' ? '' : msg.relPath, msg.fileName + (msg.ext === 'php'? '.php': '.html'));
                const exists = fs.existsSync(targetPath);
                panel.webview.postMessage({ type: 'validationResult', exists });
            } else if (msg.type === 'save') {
                const relPath: string = msg.relPath; // '.' or relative folder
                const fileBase: string = msg.fileName || 'untitled';
                const ext: string = msg.ext === 'php' ? 'php' : 'html';
                const targetPath = path.join(siteRoot, relPath === '.' ? '' : relPath, `${fileBase}.${ext}`);
                if (fs.existsSync(targetPath) && !msg.overwrite) {
                    // Request overwrite confirmation
                    const choice = await vscode.window.showWarningMessage(`The file "${path.relative(siteRoot, targetPath)}" already exists. Overwrite?`, 'Yes', 'No', 'Cancel');
                    if (choice === 'Yes') {
                        await writeNewInstance(targetPath, templatePath, ext);
                        panel.dispose();
                    } else if (choice === 'No') {
                        panel.webview.postMessage({ type: 'overwriteDenied' });
                    } else {
                        panel.dispose();
                    }
                } else {
                    await writeNewInstance(targetPath, templatePath, ext);
                    panel.dispose();
                }
            } else if (msg.type === 'cancel') {
                panel.dispose();
            }
        });

        async function writeNewInstance(targetPath: string, templatePath: string, ext: string) {
            try {
                let output = fs.readFileSync(templatePath, 'utf8'); // start as raw copy (duplicate template)

                // Determine lock flag from template (default true)
                const info = /<!--\s*TemplateInfo\s+codeOutsideHTMLIsLocked="(true|false)"\s*-->/i.exec(output);
                const lockFlag = info ? info[1].toLowerCase() : 'true';

                // Insert InstanceBegin after <html...> preserving original <html> tag exactly once.
                // Remove only the existing template header (do NOT remove InstanceBeginEditable / Repeat markers)
                output = output.replace(/<!--\s*InstanceBegin\s+template="[^"]+"[^>]*-->/i, '');
                // Mark placeholder CHANGE first, then replace with final lockFlag after confirm.
                output = output.replace(/(<html[^>]*>)/i, (m)=> `${m}<!-- InstanceBegin template="/Templates/${path.basename(templatePath)}" codeOutsideHTMLIsLocked="CHANGE" -->`);

                // Convert TemplateBeginEditable/TemplateEndEditable to Instance equivalents (keep region names/content)
                output = output.replace(/<!--\s*TemplateBeginEditable/g, '<!-- InstanceBeginEditable');
                output = output.replace(/TemplateEndEditable/g, 'InstanceEndEditable');

                // Convert Template repeat related markers
                output = output.replace(/<!--\s*TemplateBeginRepeat/g, '<!-- InstanceBeginRepeat');
                output = output.replace(/TemplateEndRepeat/g, 'InstanceEndRepeat');
                output = output.replace(/TemplateBeginRepeatEntry/g, 'InstanceBeginRepeatEntry');
                output = output.replace(/TemplateEndRepeatEntry/g, 'InstanceEndRepeatEntry');

                // Finally convert any other TemplateBegin/TemplateEnd (safety) AFTER specific ones handled
                output = output.replace(/<!--\s*TemplateBegin/g, '<!-- InstanceBegin');
                output = output.replace(/TemplateEnd/g, 'InstanceEnd');

                // Remove TemplateInfo line entirely from instance file
                output = output.replace(/<!--\s*TemplateInfo\s+codeOutsideHTMLIsLocked="(true|false)"\s*-->/ig, '');

                // Replace CHANGE with proper lock flag validation (only true/false accepted)
                const finalLock = (lockFlag === 'true' || lockFlag === 'false') ? lockFlag : 'true';
                output = output.replace(/codeOutsideHTMLIsLocked="CHANGE"/, `codeOutsideHTMLIsLocked="${finalLock}"`);

                // Ensure single InstanceEnd before </html>
                output = output.replace(/<!--\s*InstanceEnd\s*-->/ig, '');
                output = output.replace(/(<\/html>)/i, '<!-- InstanceEnd -->$1');

                // Balance check: remove stray InstanceEndEditable without matching begin (simple stack)
                const tokenRe = /<!--\s*Instance(BeginEditable|EndEditable)[^>]*-->/g;
                let match: RegExpExecArray | null; let balance = 0; const removals: {start:number;end:number}[] = [];
                while ((match = tokenRe.exec(output)) !== null) {
                    const isBegin = /BeginEditable/i.test(match[0]);
                    if (isBegin) balance++; else { if (balance === 0) removals.push({start:match.index,end:match.index+match[0].length}); else balance--; }
                }
                if (removals.length) {
                    removals.sort((a,b)=>b.start-a.start).forEach(r=>{ output = output.slice(0,r.start)+output.slice(r.end); });
                }
                // Change extension-specific things (none currently) - placeholder
                const dir = path.dirname(targetPath);
                fs.mkdirSync(dir, { recursive: true });
                // Ensure any TemplateEndRepeat left is converted properly with entry markers (defensive)
                output = output.replace(/<!--\s*TemplateEndRepeat\s*-->/gi, '<!-- InstanceEndRepeatEntry --><!-- InstanceEndRepeat -->');
                fs.writeFileSync(targetPath, output, 'utf8');
                const rel = path.relative(siteRoot, targetPath).replace(/\\/g,'/');
                vscode.window.showInformationMessage(`Created new page: ${rel}`);
                const doc = await vscode.workspace.openTextDocument(targetPath);
                await vscode.window.showTextDocument(doc);
                logProcessCompletion('createPageFromTemplate');
            } catch (e:any) {
                vscode.window.showErrorMessage(`Failed to create page: ${e.message || e}`);
                logProcessCompletion('createPageFromTemplate', 1);
            }
        }

                function getCreatePageHtml(flatFolders: any[], nonce: string): string {
                        // Build a hierarchical map for dynamic expand/collapse in client
                        const json = JSON.stringify(flatFolders);
                        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Create Page</title>
<style>
body { font-family: Consolas, monospace; padding:12px; }
fieldset { border:1px solid #888; margin-bottom:12px; }
legend { font-weight:bold; }
.row { margin:8px 0; }
label { display:inline-block; min-width:100px; }
input[type=text] { width:260px; }
.ext-toggle span { cursor:pointer; padding:4px 10px; border:1px solid #666; margin-right:4px; }
.ext-toggle span.active { background:#004; color:#fff; }
.folder-container { border:1px solid #666; height:240px; overflow:auto; padding:4px; background:#111; color:#ccc; font-size:13px; }
.folder { cursor:pointer; user-select:none; white-space:nowrap; }
.folder.selected { background:#333; color:#fff; }
.buttons { text-align:center; margin-top:16px; }
button { width:140px; padding:6px 0; margin:0 12px; font-weight:bold; }
button#saveBtn { background:#0a0; color:#fff; border:1px solid #050; }
button#cancelBtn { background:#555; color:#fff; border:1px solid #333; }
.exist-warning { color:#f80; font-size:12px; height:16px; }
.twisty { display:inline-block; width:14px; }
.collapsed > .children { display:none; }
.children { margin-left:16px; }
</style></head><body>
<div class="row"><strong>Create New Page from Template</strong></div>
<div class="row ext-toggle" id="extToggle" role="radiogroup" aria-label="File Extension">
  <span data-ext="html" class="active" role="radio" aria-checked="true">html</span>
  <span data-ext="php" role="radio" aria-checked="false">php</span>
</div>
<div class="row"><label>File Name:</label><input id="fileName" type="text" value="untitled" /> <span>. <span id="extLabel">html</span></span></div>
<div class="exist-warning" id="existWarn"></div>
<div class="row"><label style="vertical-align:top;">Save to Folder:</label>
    <div class="folder-container" id="folderContainer"></div>
</div>
<div class="buttons"><button id="saveBtn">Save</button><button id="cancelBtn">Cancel</button></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let currentExt = 'html';
let selectedRel = '.';
const flat = ${json};

// Build tree (flat contains ordered depth info). We'll reconstruct parent-child by path depth.
const byRel = new Map(flat.map(f => [f.rel, f]));
function relDepth(rel){ return rel === '.' ? 0 : rel.split('/').length; }
function childrenOf(rel){
    return flat.filter(f => f.rel !== rel && (rel === '.' ? !f.rel.includes('/') : f.rel.startsWith(rel + '/')) && relDepth(f.rel) === relDepth(rel)+1);
}

function buildNode(rel){
    const data = byRel.get(rel);
    if (!data) return '';
    const kids = childrenOf(rel);
    const hasChildren = kids.length>0;
    const label = data.display;
    let html = '<div class="folder collapsed" data-rel="'+data.rel+'">';
    html += '<div class="line"><span class="twisty">'+(hasChildren ? '▶' : '')+'</span> <span class="name">'+label+'</span></div>';
    html += '<div class="children">'+kids.map(c=>buildNode(c.rel)).join('')+'</div>';
    html += '</div>';
    return html;
}
document.getElementById('folderContainer').innerHTML = buildNode('.');

document.querySelectorAll('#extToggle span').forEach(span=>{
  span.addEventListener('click', () => {
    if (span.dataset.ext === currentExt) return; // toggle like radio
    currentExt = span.dataset.ext;
    document.querySelectorAll('#extToggle span').forEach(s=>{ s.classList.remove('active'); s.setAttribute('aria-checked','false'); });
    span.classList.add('active'); span.setAttribute('aria-checked','true');
    document.getElementById('extLabel').textContent = currentExt;
    validate();
  });
});
document.getElementById('folderContainer').addEventListener('click', (e)=>{
    const line = e.target.closest('.line');
    if (!line) return;
    const folder = line.parentElement;
    if (!folder) return;
    // Toggle collapse if has children
    if (folder.querySelector('.children') && folder.querySelector('.children').children.length) {
        folder.classList.toggle('collapsed');
        const twisty = folder.querySelector('.twisty');
        if (twisty) twisty.textContent = folder.classList.contains('collapsed') ? '▶' : '▼';
    }
    document.querySelectorAll('.folder').forEach(f=>f.classList.remove('selected'));
    folder.classList.add('selected');
    selectedRel = folder.getAttribute('data-rel');
    validate();
});
function validate(){
  const fileName = (document.getElementById('fileName').value||'').trim();
  if (!fileName) { setWarn('Enter a file name.'); return; }
  vscode.postMessage({ type:'validateName', fileName, relPath: selectedRel, ext: currentExt });
}
function setWarn(msg){ document.getElementById('existWarn').textContent = msg||''; }
document.getElementById('fileName').addEventListener('input', validate);
document.getElementById('saveBtn').addEventListener('click', ()=>{
  const fileName = (document.getElementById('fileName').value||'').trim();
  if (!fileName) { setWarn('Enter a file name.'); return; }
  vscode.postMessage({ type:'save', fileName, relPath: selectedRel, ext: currentExt });
});
document.getElementById('cancelBtn').addEventListener('click', ()=> vscode.postMessage({ type:'cancel' }));
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'validationResult') {
    setWarn(msg.exists ? 'File exists (will ask to overwrite on Save).' : '');
  } else if (msg.type === 'overwriteDenied') {
    setWarn('Choose a different name or folder.');
  }
});
validate();
</script></body></html>`;
        }
    });

    context.subscriptions.push(
        changeListener, editorChangeListener, documentOpenListener,
        showEditableRegionsCommand, toggleProtectionCommand,
        syncTemplateCommand, restoreBackupCommand, toggleTemplateSyncCommand, findInstancesCommand,
        insertRepeatEntryAfterCommand, insertRepeatEntryBeforeCommand, createPageFromTemplateCommand,
        turnOffProtectionCommand, turnOnProtectionCommand,
        nonEditableDecorationType, editableDecorationType
    );

    if (templateWatcher) {
        context.subscriptions.push(templateWatcher);
    }
}

export function deactivate() {
    console.log('Dreamweaver Template Protection deactivated');
}
