const { spawn, exec } = require('child_process');
const { getValueFromDb, getDB, batchWriteIntoDB, searchQuery } = require('./database');
let vscode;
try {
    vscode = require('vscode');
} catch (_) {
    vscode = null;
}
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const os = require('os');

async function getlno(entry) {
    if (entry && entry.line) {
        const lineIndex = Math.max(0, parseInt(entry.line, 10) - 1);
        return new vscode.Selection(lineIndex, 0, lineIndex, 0);
    }
    return new vscode.Selection(0, 0, 0, 0);
}

async function openAndReveal(context, editor, document, sel) {
    const doc = await vscode.workspace.openTextDocument(document);
    const showOptions = {
        viewColumn: editor ? editor.viewColumn : vscode.ViewColumn.One,
        selection: sel
    };
    return await vscode.window.showTextDocument(doc, showOptions);
}

async function revealInCode(context, editor, entry) {
    if (!entry) return;
    const sel = await getlno(entry);
    return openAndReveal(context, editor, entry.file, sel);
}

function getTag(editor) {
    if (!editor) return '';
    const tag = editor.document.getText(editor.selection).trim();
    if (!tag) {
        const range = editor.document.getWordRangeAtPosition(editor.selection.active);
        if (range) {
            return editor.document.getText(range);
        }
    }
    return tag;
}

async function jumputil(editor, context, key) {
    if (!key) return;
    const value = await getValueFromDb(`tag:${key}`);
    if (value) {
        console.log('Found:', value);
        const options = [value].map(tag => {
            if (!path.isAbsolute(tag.file)) {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (workspaceFolder) {
                    tag.file = path.join(workspaceFolder.uri.fsPath, tag.file);
                }
            }
            tag.description = `Line ${tag.line}`;
            tag.label = tag.file;
            tag.detail = `${tag.file}:${tag.line}`;
            return tag;
        });
        if (!options.length) {
            return vscode.window.showInformationMessage(`clangd-code: No tags found for ${key}`);
        } else if (options.length === 1) {
            return revealInCode(context, editor, options[0]);
        } else {
            return vscode.window.showQuickPick(options).then(opt => {
                return revealInCode(context, editor, opt);
            });
        }
    } else {
        console.log('Key not found');
    }
}

async function handleSearchTagsCommand(context) {
    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = 'Search tags...';
    quickPick.matchOnDescription = true;
    quickPick.filterItems = false;
    quickPick.matchOnDescription = false;
    quickPick.matchOnDetail = false;

    let abortController = null;

    quickPick.onDidChangeValue(async (input) => {
        if (abortController) {
            abortController.abort();
        }

        if (!input) {
            quickPick.items = [];
            return;
        }

        abortController = new AbortController();
        const signal = abortController.signal;

        try {
            const items = await searchQuery(input, signal);

            if (signal.aborted) return;

            quickPick.items = items.map(r => ({
                label: r.label,
                description: r.description,
                alwaysShow: true
            }));
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('Search aborted');
            } else {
                console.error(error);
            }
        }
    });

    quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        if (selected) {
            jumputil(vscode.window.activeTextEditor, context, selected.label);
        }
        quickPick.hide();
    });

    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
}

async function jump2tag(context) {
    const editor = vscode.window.activeTextEditor;
    const tag = getTag(editor);
    return jumputil(editor, context, tag);
}

module.exports = {
    jump2tag,
    handleSearchTagsCommand
};

