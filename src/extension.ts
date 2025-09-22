import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let nonEditableDecorationType: vscode.TextEditorDecorationType;
let editableDecorationType: vscode.TextEditorDecorationType;
let isProtectionEnabled = true;
let isProcessingUndo = false;
let isTemplateSyncEnabled = true;
let templateWatcher: vscode.FileSystemWatcher | undefined;

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
                // Check if inserting right at the start of a protected region
                if (changeStart.isEqual(protectedRange.start)) {
                    return true;
                }
                
                // Check if inserting right at the end of a protected region
                if (changeStart.isEqual(protectedRange.end)) {
                    return true;
                }
                
                // Check if inserting within protected region (should be caught above, but double-check)
                if (protectedRange.contains(changeStart)) {
                    return true;
                }
            }
            
            // 5. Check if the change would affect content that spans into protected region
            if (change.text.length > 0) {
                // Calculate where the insertion would end
                const lines = change.text.split('\n');
                let endLine = changeStart.line + lines.length - 1;
                let endChar = lines.length === 1 ? 
                    changeStart.character + change.text.length : 
                    lines[lines.length - 1].length;
                
                const insertionEndPos = new vscode.Position(endLine, endChar);
                
                // Check if the insertion would end up in a protected region
                if (protectedRange.contains(insertionEndPos)) {
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
                editor.selection = currentSelection;
            } catch {
                // If position is invalid, move to start of document
                editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
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
                    const regionIndex = regionNames.indexOf(selectedRegion);
                    if (regionIndex !== -1 && vscode.window.activeTextEditor) {
                        const range = editableRanges[regionIndex];
                        vscode.window.activeTextEditor.selection = new vscode.Selection(range.start, range.start);
                        vscode.window.activeTextEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
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

    // Helper function to manually find HTML files when no workspace is available
    function findHtmlFilesInDirectory(dirPath: string): string[] {
        const htmlFiles: string[] = [];
        
        try {
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            
            for (const item of items) {
                const fullPath = path.join(dirPath, item.name);
                
                if (item.isDirectory()) {
                    // Skip common directories that shouldn't contain HTML files
                    if (item.name === 'node_modules' || item.name === '.git' || item.name === '.vscode') {
                        continue;
                    }
                    // Recursively search subdirectories
                    htmlFiles.push(...findHtmlFilesInDirectory(fullPath));
                } else if (item.isFile() && item.name.toLowerCase().endsWith('.html')) {
                    htmlFiles.push(fullPath);
                }
            }
        } catch (error) {
            console.error(`Error reading directory ${dirPath}:`, error);
        }
        
        return htmlFiles;
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
                console.log(`Template ${templateName} is not in a "Templates" folder. Current folder: ${templateDirName}`);
                vscode.window.showWarningMessage(`Template must be in a "Templates" folder. Current folder: "${templateDirName}"`);
                return instances;
            }
            
            // Get the parent directory of "Templates" (this is the site root)
            const siteRoot = path.dirname(templateDir);
            console.log(`DEBUG: Site root determined as: ${siteRoot}`);
            
            // Convert to workspace-relative path for VS Code's findFiles
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                console.log('DEBUG: No workspace folder found, using file-based search');
                
                // If no workspace, search from the site root directly
                const siteRootUri = vscode.Uri.file(siteRoot);
                
                // Use a manual file search since findFiles won't work without workspace
                const htmlFiles = await findHtmlFilesInDirectory(siteRoot);
                console.log(`DEBUG: Found ${htmlFiles.length} HTML files using manual search`);
                
                for (const filePath of htmlFiles) {
                    try {
                        const file = vscode.Uri.file(filePath);
                        const fileRelativePath = path.relative(siteRoot, filePath);
                        console.log(`DEBUG: Checking file: ${filePath}, relative path: ${fileRelativePath}`);
                        
                        if (fileRelativePath.startsWith('..')) {
                            console.log(`DEBUG: Skipping file outside site root: ${filePath}`);
                            continue;
                        }
                        
                        const content = fs.readFileSync(filePath, 'utf8');
                        
                        const instanceBeginRegex = /<!--\s*InstanceBegin\s+template="([^"]+)"/;
                        const match = content.match(instanceBeginRegex);
                        
                        if (match) {
                            const referencedTemplate = match[1];
                            console.log(`DEBUG: Found template reference: ${referencedTemplate} in file: ${filePath}`);
                            
                            const normalizedReference = referencedTemplate.replace(/^\/+/, '').replace(/\\/g, '/');
                            const expectedReference1 = `Templates/${templateName}`;
                            const expectedReference2 = `/Templates/${templateName}`;
                            
                            console.log(`DEBUG: Normalized reference: ${normalizedReference}`);
                            console.log(`DEBUG: Expected reference 1: ${expectedReference1}`);
                            console.log(`DEBUG: Expected reference 2: ${expectedReference2}`);
                            
                            if (normalizedReference === expectedReference1 || referencedTemplate === expectedReference2) {
                                console.log(`DEBUG: Template match found: ${filePath}`);
                                instances.push(file);
                            } else {
                                console.log(`DEBUG: No match for this template reference`);
                            }
                        } else {
                            console.log(`DEBUG: No template reference found in: ${filePath}`);
                        }
                    } catch (error) {
                        console.error(`Error reading file ${filePath}:`, error);
                    }
                }
                
                console.log(`DEBUG: Found ${instances.length} template instances for ${templateName}`);
                return instances;
            }
            
            console.log(`DEBUG: Workspace folder: ${workspaceFolder.uri.fsPath}`);
            
            const siteRootRelative = path.relative(workspaceFolder.uri.fsPath, siteRoot);
            let searchPattern: string;
            
            console.log(`DEBUG: Site root relative to workspace: "${siteRootRelative}"`);
            
            if (siteRootRelative === '') {
                // Site root is the workspace root
                searchPattern = '**/*.html';
            } else {
                // Site root is a subdirectory within workspace
                searchPattern = `${siteRootRelative}/**/*.html`;
            }
            
            console.log(`DEBUG: Searching for HTML files with pattern: ${searchPattern}`);
            
            // Find all HTML files within the site root and its subdirectories
            const htmlFiles = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**');
            
            console.log(`DEBUG: Found ${htmlFiles.length} HTML files to check`);
            htmlFiles.forEach(file => console.log(`DEBUG: HTML file: ${file.fsPath}`));
            
            for (const file of htmlFiles) {
                try {
                    // Ensure the file is within the site root boundaries
                    const fileRelativePath = path.relative(siteRoot, file.fsPath);
                    console.log(`DEBUG: Checking file: ${file.fsPath}, relative path: ${fileRelativePath}`);
                    
                    if (fileRelativePath.startsWith('..')) {
                        // File is outside site root, skip it
                        console.log(`DEBUG: Skipping file outside site root: ${file.fsPath}`);
                        continue;
                    }
                    
                    const content = fs.readFileSync(file.fsPath, 'utf8');
                    
                    // Look for template reference that matches our template
                    const instanceBeginRegex = /<!--\s*InstanceBegin\s+template="([^"]+)"[^>]*-->/;
                    const match = content.match(instanceBeginRegex);
                    
                    if (match) {
                        const referencedTemplate = match[1];
                        console.log(`DEBUG: Found template reference: ${referencedTemplate} in file: ${file.fsPath}`);
                        
                        // Check if this references our template
                        // Handle both absolute paths (/Templates/template.dwt) and relative paths (Templates/template.dwt)
                        const normalizedReference = referencedTemplate.replace(/^\/+/, '').replace(/\\/g, '/');
                        const expectedReference1 = `Templates/${templateName}`;
                        const expectedReference2 = `/Templates/${templateName}`;
                        
                        console.log(`DEBUG: Normalized reference: ${normalizedReference}`);
                        console.log(`DEBUG: Expected reference 1: ${expectedReference1}`);
                        console.log(`DEBUG: Expected reference 2: ${expectedReference2}`);
                        
                        if (normalizedReference === expectedReference1 || referencedTemplate === expectedReference2) {
                            console.log(`DEBUG: Template match found: ${file.fsPath}`);
                            instances.push(file);
                        } else {
                            console.log(`DEBUG: No match for this template reference`);
                        }
                    } else {
                        console.log(`DEBUG: No template reference found in: ${file.fsPath}`);
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

    function mergeTemplateWithEditableContent(templateContent: string, editableContent: Map<string, string>, originalInstanceContent?: string): string {
        let mergedContent = templateContent;
        
        // Replace TemplateBeginEditable/TemplateEndEditable with InstanceBeginEditable/InstanceEndEditable
        mergedContent = mergedContent.replace(/<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->/g, 
            '<!-- InstanceBeginEditable name="$1" -->');
        mergedContent = mergedContent.replace(/<!--\s*TemplateEndEditable\s*-->/g, 
            '<!-- InstanceEndEditable -->');
        
        // Preserve original template reference from instance file or add if not present
        let templateReference = '/Templates/page.dwt'; // Default fallback
        let hasExistingInstanceComments = false;
        
        if (originalInstanceContent) {
            // Extract template reference from original instance
            const instanceBeginMatch = originalInstanceContent.match(/<!--\s*InstanceBegin\s+template="([^"]+)"[^>]*-->/);
            if (instanceBeginMatch) {
                templateReference = instanceBeginMatch[1];
                hasExistingInstanceComments = true;
            }
        }
        
        // Always add InstanceBegin and InstanceEnd comments (they might get stripped during template merge)
        // Remove any existing ones first to avoid duplicates
        mergedContent = mergedContent.replace(/<!--\s*InstanceBegin[^>]*-->/g, '');
        mergedContent = mergedContent.replace(/<!--\s*InstanceEnd\s*-->/g, '');
        
        // Add them in the proper locations
        mergedContent = mergedContent.replace(/(<html[^>]*>)/i, 
            `$1\n<!-- InstanceBegin template="${templateReference}" codeOutsideHTMLIsLocked="false" -->`);
        mergedContent = mergedContent.replace(/(<\/html>)/i, '<!-- InstanceEnd -->\n$1');
        
        // Replace editable regions with saved content
        editableContent.forEach((content, regionName) => {
            const regionRegex = new RegExp(
                `(<!--\\s*InstanceBeginEditable\\s+name="${regionName}"\\s*-->)[\\s\\S]*?(<!--\\s*InstanceEndEditable\\s*-->)`,
                'g'
            );
            mergedContent = mergedContent.replace(regionRegex, `$1${content}$2`);
        });
        
        return mergedContent;
    }

    async function updateInstanceFromTemplate(templateContent: string, instanceUri: vscode.Uri): Promise<boolean> {
        try {
            const instanceContent = fs.readFileSync(instanceUri.fsPath, 'utf8');
            
            // Extract editable content from current instance
            const editableContent = extractEditableContent(instanceContent);
            
            // Merge template with preserved editable content and original template reference
            const updatedContent = mergeTemplateWithEditableContent(templateContent, editableContent, instanceContent);
            
            // Write updated content back to instance file
            fs.writeFileSync(instanceUri.fsPath, updatedContent, 'utf8');
            
            console.log(`Successfully updated instance: ${instanceUri.fsPath}`);
            return true;
        } catch (error) {
            console.error(`Error updating instance ${instanceUri.fsPath}:`, error);
            return false;
        }
    }

    async function updateHtmlBasedOnTemplate(templateUri: vscode.Uri): Promise<void> {
        if (!isTemplateSyncEnabled) {
            return;
        }

        try {
            console.log(`Starting Dreamweaver-style update for template: ${templateUri.fsPath}`);
            
            // Temporarily disable protection during update
            const originalProtectionState = isProtectionEnabled;
            isProtectionEnabled = false;
            
            const templateContent = fs.readFileSync(templateUri.fsPath, 'utf8');
            const instances = await findTemplateInstances(templateUri.fsPath);
            
            if (instances.length === 0) {
                const templateDir = path.dirname(templateUri.fsPath);
                const templateDirName = path.basename(templateDir);
                
                let message = `No instance files found for template ${path.basename(templateUri.fsPath)}`;
                if (templateDirName !== 'Templates') {
                    message += `\n\nNote: Template must be in a folder named "Templates" for instance detection to work. Current folder: "${templateDirName}"`;
                }
                
                vscode.window.showInformationMessage(message);
                return;
            }

            console.log(`Found ${instances.length} instances to update`);

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
            
            const updatePromises = instances.map(instanceUri => 
                updateInstanceLikeDreamweaver([], instanceUri, templateUri.fsPath)
            );
            
            const results = await Promise.all(updatePromises);
            const successCount = results.filter(success => success).length;
            const failCount = results.length - successCount;
            
            let message = `Updated ${successCount} HTML file(s) based on template ${path.basename(templateUri.fsPath)}`;
            if (failCount > 0) {
                message += ` (${failCount} failed)`;
            }
            
            vscode.window.showInformationMessage(message);
            
            // Restore protection
            isProtectionEnabled = originalProtectionState;
            
            // Refresh any open editors by reopening the files
            console.log('Refreshing editors...');
            for (const instanceUri of instances) {
                try {
                    await vscode.workspace.openTextDocument(instanceUri);
                } catch (error) {
                    console.log(`Could not refresh editor for ${instanceUri.fsPath}: ${error}`);
                }
            }
            
        } catch (error) {
            // Restore protection on error
            isProtectionEnabled = true;
            console.error('Error updating HTML based on template:', error);
            vscode.window.showErrorMessage(
                `Failed to update HTML files from template ${path.basename(templateUri.fsPath)}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    interface TemplateRegion {
        name: string;
        beforeContent: string;
        afterContent: string;
        order: number;
    }

    function extractTemplateRegions(templateContent: string): TemplateRegion[] {
        const regions: TemplateRegion[] = [];
        
        // Find all TemplateBeginEditable regions in the template
        const editableRegex = /<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndEditable\s*-->/g;
        
        let match;
        let lastIndex = 0;
        let order = 0;
        
        while ((match = editableRegex.exec(templateContent)) !== null) {
            const regionName = match[1];
            const matchStart = match.index;
            const matchEnd = editableRegex.lastIndex;
            
            // Get content before this editable region
            const beforeContent = templateContent.substring(lastIndex, matchStart);
            
            regions.push({
                name: regionName,
                beforeContent: beforeContent,
                afterContent: '', // Will be set for the last region
                order: order++
            });
            
            lastIndex = matchEnd;
        }
        
        // Add the content after the last editable region
        if (regions.length > 0) {
            const afterLastRegion = templateContent.substring(lastIndex);
            regions[regions.length - 1].afterContent = afterLastRegion;
        }
        
        return regions;
    }

    function extractEditableContent(instanceContent: string): Map<string, string> {
        const editableContent = new Map<string, string>();
        const editableRegex = /<!--\s*InstanceBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*InstanceEndEditable\s*-->/g;
        
        let match;
        while ((match = editableRegex.exec(instanceContent)) !== null) {
            const regionName = match[1];
            const content = match[2];
            editableContent.set(regionName, content);
        }
        
        return editableContent;
    }

    function reconstructHtmlFromTemplate(templateRegions: TemplateRegion[], editableContent: Map<string, string>, originalTemplatePath: string): string {
        let reconstructedHtml = '';
        
        for (const region of templateRegions) {
            // Add the template content before this editable region
            reconstructedHtml += region.beforeContent;
            
            // Convert TemplateBeginEditable to InstanceBeginEditable and add preserved content
            const instanceEditableStart = `<!-- InstanceBeginEditable name="${region.name}" -->`;
            const instanceEditableEnd = `<!-- InstanceEndEditable -->`;
            
            reconstructedHtml += instanceEditableStart;
            
            // Add preserved editable content or empty if not found
            const preservedContent = editableContent.get(region.name) || '';
            reconstructedHtml += preservedContent;
            
            reconstructedHtml += instanceEditableEnd;
        }
        
        // Add content after the last region
        if (templateRegions.length > 0) {
            reconstructedHtml += templateRegions[templateRegions.length - 1].afterContent;
        }
        
        // Ensure InstanceEnd comment is present at the end (will be handled by updateInstanceLikeDreamweaver)
        if (!reconstructedHtml.includes('<!-- InstanceEnd')) {
            reconstructedHtml = reconstructedHtml.replace(/(<\/html>)/i, '<!-- InstanceEnd -->\n$1');
        }
        
        return reconstructedHtml;
    }

    async function updateInstanceLikeDreamweaver(templateRegions: TemplateRegion[], instanceUri: vscode.Uri, templatePath: string): Promise<boolean> {
        try {
            const instanceContent = fs.readFileSync(instanceUri.fsPath, 'utf8');
            const templateContent = fs.readFileSync(templatePath, 'utf8');
            
            console.log(`Updating instance: ${instanceUri.fsPath}`);
            
            // Step 1: Preserve InstanceBegin comment
            const instanceBeginMatch = instanceContent.match(/<!--\s*InstanceBegin\s+template="([^"]+)"[^>]*-->/);
            let preservedInstanceBegin = '';
            if (instanceBeginMatch) {
                preservedInstanceBegin = instanceBeginMatch[0];
            } else {
                const templateName = path.basename(templatePath);
                preservedInstanceBegin = `<!-- InstanceBegin template="/Templates/${templateName}" codeOutsideHTMLIsLocked="false" -->`;
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
                console.log(`\n=== Processing template region: "${regionName}" ===`);
                console.log(`Default content: "${defaultContent.substring(0, 50)}..."`);
                
                // Use preserved content if available, otherwise use template default
                const content = editableContent.get(regionName) || defaultContent;
                console.log(`Using content: "${content.substring(0, 50)}..."`);
                
                const replacement = `<!-- InstanceBeginEditable name="${regionName}" -->${content}<!-- InstanceEndEditable -->`;
                console.log(`Replacement string: "${replacement.substring(0, 100)}..."`);
                
                return replacement;
            });
            
            console.log(`Template replacement completed`);
            
            // Step 4: Add InstanceBegin comment after <html> tag (same line)
            updatedContent = updatedContent.replace(/<!--\s*InstanceBegin\s+template=[^>]*-->\s*/g, ''); // Remove only template references
            updatedContent = updatedContent.replace(/(<html[^>]*>)/i, `$1${preservedInstanceBegin}`);
            
            console.log(`Added InstanceBegin comment`);
            
            // Step 5: Add InstanceEnd comment before </html> tag
            if (!updatedContent.includes('<!-- InstanceEnd')) {
                updatedContent = updatedContent.replace(/(<\/html>)/i, '<!-- InstanceEnd -->\n$1');
            }
            
            // Step 6: Write updated content to file
            fs.writeFileSync(instanceUri.fsPath, updatedContent, 'utf8');
            
            console.log(`Successfully updated instance: ${instanceUri.fsPath}`);
            return true;
        } catch (error) {
            console.error(`Error updating instance ${instanceUri.fsPath}:`, error);
            return false;
        }
    }

    function setupTemplateWatcher(): void {
        if (templateWatcher) {
            templateWatcher.dispose();
        }

        // Watch for changes to .dwt files
        templateWatcher = vscode.workspace.createFileSystemWatcher('**/*.dwt');
        
        templateWatcher.onDidChange(async (uri) => {
            const config = vscode.workspace.getConfiguration('dreamweaverTemplate');
            const autoSync = config.get<boolean>('autoSyncOnTemplateChange', true);
            
            if (autoSync) {
                await updateHtmlBasedOnTemplate(uri);
            }
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
            
            // Check if any changes are in protected regions
            const hasProtectedChanges = event.contentChanges.some(change => 
                isProtectedRegionChange(change, protectedRanges, editor.document)
            );

            if (hasProtectedChanges) {
                // Restore entire document from snapshot
                await restoreFromSnapshot(editor);
                
                if (vscode.workspace.getConfiguration('dreamweaverTemplate').get('showWarnings', true)) {
                    vscode.window.showWarningMessage('Cannot modify protected regions of a Dreamweaver template.');
                }
            } else {
                // Changes are in editable regions, update snapshot
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
            vscode.window.showInformationMessage('No Dreamweaver template is currently open.');
        }
    });

    const toggleProtectionCommand = vscode.commands.registerCommand('dreamweaverTemplate.toggleProtection', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && (isDreamweaverTemplate(editor.document) || isDreamweaverTemplateFile(editor.document))) {
            const config = vscode.workspace.getConfiguration('dreamweaverTemplate');
            const isEnabled = config.get('enableProtection', true);
            config.update('enableProtection', !isEnabled, vscode.ConfigurationTarget.Global).then(() => {
                updateDecorations(editor); 
                vscode.window.showInformationMessage(`Dreamweaver template protection ${!isEnabled ? 'enabled' : 'disabled'}.`);
            });
        }
    });

    const syncTemplateCommand = vscode.commands.registerCommand('dreamweaverTemplate.syncTemplate', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.fileName.endsWith('.dwt')) {
            await updateHtmlBasedOnTemplate(editor.document.uri);
        } else {
            vscode.window.showWarningMessage('Please open a Dreamweaver template file (.dwt) to update HTML files.');
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
        if (editor && editor.document.fileName.endsWith('.dwt')) {
            const instances = await findTemplateInstances(editor.document.uri.fsPath);
            if (instances.length === 0) {
                vscode.window.showInformationMessage(
                    `No instance files found for template ${path.basename(editor.document.fileName)}`
                );
            } else {
                const items = instances.map(uri => ({
                    label: path.basename(uri.fsPath),
                    description: vscode.workspace.asRelativePath(uri),
                    uri: uri
                }));
                
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select an instance file to open'
                });
                
                if (selected) {
                    await vscode.window.showTextDocument(selected.uri);
                }
            }
        } else {
            vscode.window.showWarningMessage('Please open a Dreamweaver template file (.dwt) to find instances.');
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
        syncTemplateCommand, toggleTemplateSyncCommand, findInstancesCommand,
        nonEditableDecorationType, editableDecorationType
    );

    if (templateWatcher) {
        context.subscriptions.push(templateWatcher);
    }
}

export function deactivate() {
    console.log('Dreamweaver Template Protection deactivated');
}