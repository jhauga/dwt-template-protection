import * as vscode from 'vscode';

let nonEditableDecorationType: vscode.TextEditorDecorationType;
let editableDecorationType: vscode.TextEditorDecorationType;
let isProtectionEnabled = true;
let isProcessingUndo = false;

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
        if (!editor || !isDreamweaverTemplate(editor.document)) {
            if (editor) {
                editor.setDecorations(nonEditableDecorationType, []);
                editor.setDecorations(editableDecorationType, []);
            }
            return;
        }

        const config = vscode.workspace.getConfiguration('dreamweaverTemplate');
        isProtectionEnabled = config.get('enableProtection', true);

        if (!isProtectionEnabled) {
            editor.setDecorations(nonEditableDecorationType, []);
            editor.setDecorations(editableDecorationType, []);
            return;
        }

        const protectedRanges = getProtectedRanges(editor.document);
        const editableRanges = getEditableRanges(editor.document);

        editor.setDecorations(nonEditableDecorationType, config.get('highlightProtectedRegions', true) ? protectedRanges : []);
        editor.setDecorations(editableDecorationType, config.get('highlightEditableRegions', true) ? editableRanges : []);
    }

    const changeListener = vscode.workspace.onDidChangeTextDocument(event => {
        if (isProcessingUndo) return;

        const editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor.document && isProtectionEnabled) {
            const protectedRanges = getProtectedRanges(editor.document);
            const wasChangeInProtectedRegion = event.contentChanges.some(change => {
                const changeRange = new vscode.Range(change.range.start, editor.document.positionAt(editor.document.offsetAt(change.range.start) + change.text.length));
                const intersection = protectedRanges.some(protectedRange => {
                    const intersect = protectedRange.intersection(changeRange);
                    return !!intersect && !intersect.isEmpty;
                });
                return intersection;
            });

            if (wasChangeInProtectedRegion) {
                if (vscode.workspace.getConfiguration('dreamweaverTemplate').get('showWarnings', true)) {
                    vscode.window.showWarningMessage('You cannot edit a protected region of a Dreamweaver template.');
                }
                isProcessingUndo = true;
                vscode.commands.executeCommand('undo').then(() => { isProcessingUndo = false; });
            }
        }
    });

    const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(editor => {
        updateDecorations(editor);
    });

    const documentOpenListener = vscode.workspace.onDidOpenTextDocument(document => {
        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document === document) {
            updateDecorations(vscode.window.activeTextEditor);
        }
    });

    const showEditableRegionsCommand = vscode.commands.registerCommand('dreamweaverTemplate.showEditableRegions', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && isDreamweaverTemplate(editor.document)) {
            showEditableRegionsList(editor.document);
        } else {
            vscode.window.showInformationMessage('No Dreamweaver template is currently open.');
        }
    });

    const toggleProtectionCommand = vscode.commands.registerCommand('dreamweaverTemplate.toggleProtection', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && isDreamweaverTemplate(editor.document)) {
            const config = vscode.workspace.getConfiguration('dreamweaverTemplate');
            const isEnabled = config.get('enableProtection', true);
            config.update('enableProtection', !isEnabled, vscode.ConfigurationTarget.Global).then(() => {
                updateDecorations(editor); 
                vscode.window.showInformationMessage(`Dreamweaver template protection ${!isEnabled ? 'enabled' : 'disabled'}.`);
            });
        }
    });

    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
    }

    context.subscriptions.push(
        changeListener, editorChangeListener, documentOpenListener,
        showEditableRegionsCommand, toggleProtectionCommand,
        nonEditableDecorationType, editableDecorationType
    );
}

export function deactivate() {
    console.log('Dreamweaver Template Protection deactivated');
}