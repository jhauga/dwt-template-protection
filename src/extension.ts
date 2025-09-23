import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let nonEditableDecorationType: vscode.TextEditorDecorationType;
let editableDecorationType: vscode.TextEditorDecorationType;
let isProtectionEnabled = true;
let isProcessingUndo = false;
let isTemplateSyncEnabled = true;
let templateWatcher: vscode.FileSystemWatcher | undefined;

// Store last backup information for restore functionality
let lastBackupInfo: { backupDir: string; templateName: string; instances: vscode.Uri[] } | undefined;

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
        // Protect instance files (.html with Dreamweaver comments)
        return isDreamweaverTemplate(document);
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

    function updateDecorations(editor: vscode.TextEditor | undefined) {
        if (!editor) {
            return;
        }

        const config = vscode.workspace.getConfiguration('dreamweaverTemplate');
        isProtectionEnabled = config.get('enableProtection', true);

        // Clear decorations if protection is disabled or if this is a .dwt file
        if (!isProtectionEnabled || isDreamweaverTemplateFile(editor.document)) {
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

    // Create backup of HTML files before updating
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
            
            console.log(`Backing up ${instances.length} HTML files to: ${backup1Dir}`);
            
            // Backup each HTML file to the new backup 1 directory
            for (const instanceUri of instances) {
                try {
                    const fileName = path.basename(instanceUri.fsPath);
                    const backupPath = path.join(backup1Dir, fileName);
                    
                    // Copy file to backup location
                    const content = fs.readFileSync(instanceUri.fsPath, 'utf8');
                    fs.writeFileSync(backupPath, content, 'utf8');
                    
                    console.log(`Backed up: ${fileName}`);
                } catch (error) {
                    console.error(`Error backing up ${instanceUri.fsPath}:`, error);
                }
            }
            
            console.log(`All HTML files backed up to: ${backup1Dir}`);
            
            // Store backup info for restore functionality
            lastBackupInfo = { backupDir: backup1Dir, templateName, instances };
            
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
                const { backupDir, templateName, instances } = lastBackupInfo!;
                if (!fs.existsSync(backupDir)) {
                    vscode.window.showErrorMessage(`Backup directory not found: ${backupDir}`);
                    return;
                }
                progress.report({ message: `Found backup for template ${templateName}`, increment: 5 });
                let restoredCount = 0;
                let failedCount = 0;
                const total = instances.length || 1;
                for (let i = 0; i < instances.length; i++) {
                    const instanceUri = instances[i];
                    try {
                        const fileName = path.basename(instanceUri.fsPath);
                        const backupPath = path.join(backupDir, fileName);
                        if (fs.existsSync(backupPath)) {
                            const backupContent = fs.readFileSync(backupPath, 'utf8');
                            fs.writeFileSync(instanceUri.fsPath, backupContent, 'utf8');
                            restoredCount++;
                        } else {
                            failedCount++;
                        }
                    } catch {
                        failedCount++;
                    }
                    progress.report({ increment: 80 / total, message: `Restored ${i + 1}/${total}` });
                }
                // Refresh editors
                for (const instanceUri of instances) {
                    try { await vscode.workspace.openTextDocument(instanceUri); } catch { /* ignore */ }
                }
                const message = `Restored ${restoredCount} HTML file(s) from template "${templateName}" backup${failedCount ? ` (${failedCount} failed)` : ''}`;
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
            const templateFiles = await vscode.workspace.findFiles('**/Templates/*.dwt');
            
            for (const templateFile of templateFiles) {
                // Skip the current template
                if (templateFile.fsPath === templatePath) {
                    continue;
                }
                
                try {
                    const content = fs.readFileSync(templateFile.fsPath, 'utf8');
                    
                    // Check if this template references our template
                    const instanceBeginRegex = /<!--\s*InstanceBegin\s+template="([^"]+)"/;
                    const match = content.match(instanceBeginRegex);
                    
                    if (match) {
                        const referencedTemplate = match[1];
                        // Check if it references our template (handle both absolute and relative paths)
                        if (referencedTemplate.includes(templateName) || 
                            path.basename(referencedTemplate) === templateName) {
                            childTemplates.push(templateFile);
                            console.log(`Found child template: ${templateFile.fsPath} references ${templateName}`);
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
                searchPattern = '**/*.html';
            } else {
                searchPattern = `${siteRootRelative}/**/*.html`;
            }
            
            console.log(`DEBUG: Searching for HTML files with pattern: ${searchPattern}`);
            
            // Find all HTML files within the site root and its subdirectories
            // Exclude node_modules and backup directories
            const htmlFiles = await vscode.workspace.findFiles(searchPattern, '{**/node_modules/**,**/.dwt-template-protection-backups/**}');
            
            console.log(`DEBUG: Found ${htmlFiles.length} HTML files to check (excluding .dwt-template-protection-backups)`);
            htmlFiles.forEach(file => console.log(`DEBUG: HTML file: ${file.fsPath}`));
            
            for (const file of htmlFiles) {
                try {
                    // Skip backup files as an additional safety check
                    if (file.fsPath.includes('.dwt-template-protection-backups')) {
                        console.log(`DEBUG: Skipping backup file: ${file.fsPath}`);
                        continue;
                    }
                    
                    const content = fs.readFileSync(file.fsPath, 'utf8');
                    
                    // Check if this HTML file was created from our template
                    const instanceBeginRegex = /<!--\s*InstanceBegin\s+template="([^"]+)"/;
                    const match = content.match(instanceBeginRegex);
                    
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

    async function updateInstanceLikeDreamweaver(templateRegions: any[], instanceUri: vscode.Uri, templatePath: string): Promise<boolean> {
        try {
            const instanceContent = fs.readFileSync(instanceUri.fsPath, 'utf8');
            const templateContent = fs.readFileSync(templatePath, 'utf8');
            
            console.log(`Updating instance: ${instanceUri.fsPath}`);
            
            // Step 1: Preserve InstanceBegin comment
            const instanceBeginMatch = instanceContent.match(/<!--\s*InstanceBegin\s+template="([^"]+)"[^>]*-->/);
            let preservedInstanceBegin = '';
            if (instanceBeginMatch) {
                preservedInstanceBegin = '\n' + instanceBeginMatch[0];
            } else {
                // Create default InstanceBegin if not found
                const templateName = path.basename(templatePath);
                preservedInstanceBegin = `\n<!-- InstanceBegin template="/Templates/${templateName}" codeOutsideHTMLIsLocked="false" -->`;
            }
            
            // Step 2: Extract editable content from instance file
            const editableContent = new Map<string, string>();
            const editableRegex = /<!--\s*InstanceBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*InstanceEndEditable\s*-->/g;
            
            let match;
            while ((match = editableRegex.exec(instanceContent)) !== null) {
                const regionName = match[1];
                const content = match[2];
                editableContent.set(regionName, content);
                console.log(`Preserved editable region "${regionName}"`);
            }
            
            // Step 3: Start with template content and replace all TemplateBeginEditable with InstanceBeginEditable
            let updatedContent = templateContent;
            
            // Replace TemplateBeginEditable/TemplateEndEditable with InstanceBeginEditable/InstanceEndEditable + preserved content
            const templateRegionRegex = /<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndEditable\s*-->/g;
            
            console.log(`Starting template replacement process`);
            console.log(`Template content length: ${templateContent.length}`);
            console.log(`Number of editable regions found in instance: ${editableContent.size}`);
            
            updatedContent = updatedContent.replace(templateRegionRegex, (fullMatch, regionName, defaultContent) => {
                const preservedContent = editableContent.get(regionName) || defaultContent;
                console.log(`Replacing region "${regionName}" with preserved content`);
                return `<!-- InstanceBeginEditable name="${regionName}" -->${preservedContent}<!-- InstanceEndEditable -->`;
            });
            
            console.log(`Template replacement completed`);
            
            // Step 4: Add InstanceBegin comment after <html> tag (same line)
            updatedContent = updatedContent.replace(/<!--\s*InstanceBegin\s+template=[^>]*-->\s*/g, ''); // Remove only template references
            updatedContent = updatedContent.replace(/(<html[^>]*>)/i, `$1${preservedInstanceBegin}`);
            
            console.log(`Added InstanceBegin comment`);
            
            // Step 5: Preserve or add InstanceEnd comment before </html> tag
            // First remove any existing InstanceEnd comments to avoid duplicates
            updatedContent = updatedContent.replace(/<!--\s*InstanceEnd\s*-->/g, '');
            // Then add it back in the correct position before </html>
            updatedContent = updatedContent.replace(/(<\/html>)/i, '<!-- InstanceEnd -->$1');
            
            // Step 6: Write updated content to file
            fs.writeFileSync(instanceUri.fsPath, updatedContent, 'utf8');
            
            console.log(`Successfully updated instance: ${instanceUri.fsPath}`);
            return true;
        } catch (error) {
            console.error(`Error updating instance ${instanceUri.fsPath}:`, error);
            return false;
        }
    }

    // New Dreamweaver-style template updating that preserves editable content surgically
    async function updateHtmlLikeDreamweaver(instanceUri: vscode.Uri, templatePath: string): Promise<boolean> {
        try {
            const instancePath = instanceUri.fsPath;
            console.log(`[DW-MERGE] Start merge for instance: ${instancePath}`);

            const rawInstance = fs.readFileSync(instancePath, 'utf8');
            const rawTemplate = fs.readFileSync(templatePath, 'utf8');
            const instanceContent = rawInstance.replace(/\r\n?/g, '\n');
            const templateContent = rawTemplate.replace(/\r\n?/g, '\n');

            // Preserve existing instance editable regions
            const preservedRegions = new Map<string, string>();
            const instanceEditablePattern = /<!--\s*InstanceBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*InstanceEndEditable\s*-->/g;
            let m: RegExpExecArray | null;
            while ((m = instanceEditablePattern.exec(instanceContent)) !== null) {
                preservedRegions.set(m[1], m[2]);
            }
            console.log(`[DW-MERGE] Preserved regions (${preservedRegions.size}): ${Array.from(preservedRegions.keys()).join(', ') || '(none)'}`);

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

            // InstanceBegin (preserve existing reference)
            const instanceBeginMatch = instanceContent.match(/<!--\s*InstanceBegin\s+template="([^"]+)"[^>]*-->/i);
            const instanceBegin = instanceBeginMatch ? instanceBeginMatch[0] : `<!-- InstanceBegin template="/Templates/${path.basename(templatePath)}" codeOutsideHTMLIsLocked="true" -->`;

            // Remove stray InstanceBegin occurrences in static segments to avoid duplication
            for (const s of segments) {
                if (s.kind === 'static') {
                    s.text = s.text.replace(/<!--\s*InstanceBegin[^>]*-->\s*/gi, '');
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

            // Append InstanceEnd
            rebuilt = rebuilt.replace(/<!--\s*InstanceEnd\s*-->/gi, '');
            rebuilt = rebuilt.replace(/(<\/html>)/i, '<!-- InstanceEnd -->$1');

            // Idempotency cleanup
            rebuilt = rebuilt.replace(/\n{4,}/g, '\n\n');

            // Safety guard: verify all preserved regions still present
            let missing: string[] = [];
            for (const [rName, rContent] of preservedRegions.entries()) {
                if (rContent.trim() && !rebuilt.includes(rContent.trim().slice(0, Math.min(40, rContent.trim().length)))) {
                    missing.push(rName);
                }
            }
            if (missing.length) {
                console.error(`[DW-MERGE] Safety abort: missing preserved regions: ${missing.join(', ')}`);
                vscode.window.showErrorMessage(`Skipped updating ${path.basename(instancePath)} (failed to safely preserve regions: ${missing.join(', ')})`);
                return false;
            }

            if (rebuilt !== instanceContent) {
                // Additional guard: ensure we did not accidentally shrink file drastically (>60% reduction)
                const ratio = rebuilt.length / instanceContent.length;
                if (instanceContent.length > 500 && ratio < 0.4) {
                    console.error(`[DW-MERGE] Safety abort: rebuilt size ratio ${ratio.toFixed(2)} too small.`);
                    vscode.window.showErrorMessage(`Skipped updating ${path.basename(instancePath)} (safety size check failed)`);
                    return false;
                }
                const rebuiltStaticBytes = (()=>{ // recompute static by stripping editable blocks
                    return rebuilt.replace(/<!--\s*InstanceBeginEditable[\s\S]*?InstanceEndEditable\s*-->/g,'').length;
                })();
                if (rebuiltStaticBytes < originalStaticBytes * 0.5) {
                    console.error(`[DW-MERGE] Safety abort: static content reduced from ${originalStaticBytes} to ${rebuiltStaticBytes}.`);
                    vscode.window.showErrorMessage(`Skipped updating ${path.basename(instancePath)} (static content shrink)}`);
                    return false;
                }
                fs.writeFileSync(instancePath, rebuilt, 'utf8');
                console.log(`[DW-MERGE] Wrote updated instance: ${instancePath}`);
            } else {
                console.log('[DW-MERGE] No changes needed (already up to date)');
            }
            return true;
        } catch (e) {
            console.error(`[DW-MERGE] Failed merging instance ${instanceUri.fsPath}:`, e);
            return false;
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
                
                progress.report({ increment: 20, message: `Found ${instances.length} HTML instances and ${childTemplates.length} child templates` });
                
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
                    
                    // Update child templates even if no HTML instances
                    if (childTemplates.length === 0) {
                        return; // No work to do
                    }
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
                
                // Step 4: Update HTML instances of THIS template only
                if (instances.length > 0) {
                    console.log(`Found ${instances.length} HTML instances to update`);
                    progress.report({ increment: 10, message: `Creating backups of ${instances.length} HTML files...` });

                    // Create backups of HTML files before updating
                    console.log('Creating backups of HTML files...');
                    let backupDir: string;
                    try {
                        backupDir = await createHtmlBackups(instances, templateUri.fsPath);
                        vscode.window.showInformationMessage(
                            `HTML files backed up to: ${path.basename(backupDir)}`
                        );
                    } catch (error) {
                        console.error('Backup creation failed:', error);
                        vscode.window.showErrorMessage(
                            `Failed to create backups: ${error instanceof Error ? error.message : String(error)}. Proceeding without backup.`
                        );
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
                    console.log('Starting HTML file updates...');
                    progress.report({ increment: 10, message: `Updating ${instances.length} HTML files...` });
                    
                    const updatePromises = instances.map(async (instanceUri: vscode.Uri, index: number) => {
                        // Check for cancellation before each update
                        if (token.isCancellationRequested) {
                            return false;
                        }
                        
                        const result = await updateHtmlLikeDreamweaver(instanceUri, templateUri.fsPath);
                        progress.report({ increment: 25 / instances.length, message: `Preserved content in ${index + 1}/${instances.length} HTML files` });
                        return result;
                    });
                    
                    const results = await Promise.all(updatePromises);
                    
                    // Check if operation was cancelled
                    if (token.isCancellationRequested) {
                        isProtectionEnabled = originalProtectionState;
                        vscode.window.showWarningMessage('Template update was cancelled.');
                        return;
                    }
                    
                    const successCount = results.filter((success: boolean) => success).length;
                    const failCount = results.length - successCount;
                    
                    let message = `Updated ${successCount} HTML file(s) while preserving editable content`;
                    if (childTemplates.length > 0) {
                        message += ` and ${childTemplates.length} child template(s)`;
                    }
                    message += ` based on template ${path.basename(templateUri.fsPath)}`;
                    
                    if (failCount > 0) {
                        message += ` (${failCount} failed)`;
                        vscode.window.showWarningMessage(message);
                    } else {
                        vscode.window.showInformationMessage(message);
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
                
            } catch (error) {
                console.error('Error during template update:', error);
                vscode.window.showErrorMessage(`Template update failed: ${error instanceof Error ? error.message : String(error)}`);
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
            }
        } else {
            vscode.window.showErrorMessage('This command only works on Dreamweaver template (.dwt) files.');
        }
    });

    const restoreBackupCommand = vscode.commands.registerCommand('dreamweaverTemplate.restoreBackup', async () => {
        // Check if backup info exists first
        if (!lastBackupInfo) {
            vscode.window.showErrorMessage('No backup information found. Cannot restore files.');
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
                    });
                } else {
                    vscode.window.showInformationMessage('No instances found for this template.');
                }
            });
        } else {
            vscode.window.showErrorMessage('This command only works on Dreamweaver template (.dwt) files.');
        }
    });

    // Initialize template watcher
    setupTemplateWatcher();

    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
        if (shouldProtectFromEditing(vscode.window.activeTextEditor.document)) {
            saveDocumentSnapshot(vscode.window.activeTextEditor.document);
        }
    }

    context.subscriptions.push(
        changeListener, editorChangeListener, documentOpenListener,
        showEditableRegionsCommand, toggleProtectionCommand,
        syncTemplateCommand, restoreBackupCommand, toggleTemplateSyncCommand, findInstancesCommand,
        nonEditableDecorationType, editableDecorationType
    );

    if (templateWatcher) {
        context.subscriptions.push(templateWatcher);
    }
}

export function deactivate() {
    console.log('Dreamweaver Template Protection deactivated');
}
