const vscode = require('vscode');
const path = require('path');
const fs = require('fs').promises;
const { jump2tag, handleSearchTagsCommand } = require('./query');
const { initDB, closeDB } = require('./database');
const { parseAndStoreTags } = require('./store');
const { spawn } = require('child_process');
const channel = vscode.window.createOutputChannel('clangd-code');
const config = vscode.workspace.getConfiguration('clangd-code');

const exeCmds = {
  clangd: config.get('clangdCmd') || 'clangd'
};

function getVersionAsync(cmd, versionArgs = ["--version"]) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, versionArgs, { shell: true });
        let output = "";
        child.stdout.on("data", d => output += d);
        child.stderr.on("data", d => output += d);
        child.on("error", () => {
            reject(new Error(`Please install clangd or provide clangd path in settings `));
        });
        child.on("close", (code) => {
            if (code === 0 || code === 1) {
                resolve(output.trim());
            } else {
                reject(new Error(`Please install clangd or provide clangd path in settings `));
            }
        });
    });
}

async function preflight(exeCmds) {
    await getVersionAsync(exeCmds.clangd);
}

async function storeTags() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }
  await preflight(exeCmds);

  await parseAndStoreTags(channel, workspaceFolder.uri.fsPath, exeCmds);
}

async function searchTags(context) {
  handleSearchTagsCommand(context)
}

async function goToDefinition(context) {
  const editor = vscode.window.activeTextEditor;
  await jump2tag(context, editor);
}

module.exports = {
  activate(context) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      initDB(workspaceFolder.uri.fsPath);
    }
    context.subscriptions.push(channel);
    context.subscriptions.push(vscode.commands.registerCommand('extension.storeTags', storeTags));
    context.subscriptions.push(vscode.commands.registerCommand('extension.searchTags', searchTags));
    context.subscriptions.push(vscode.commands.registerCommand('extension.jumpTag', goToDefinition));
  },
  deactivate() {
    closeDB();
  }
};