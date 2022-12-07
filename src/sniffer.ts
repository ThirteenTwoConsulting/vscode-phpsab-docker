/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2019 wongjn. All rights reserved.
 * Copyright (c) 2019 Samuel Hilson. All rights reserved.
 * Licensed under the MIT License. See License.md in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
"use strict";

import {
    Disposable,
    workspace,
    DiagnosticCollection,
    languages,
    Uri,
    CancellationTokenSource,
    ConfigurationChangeEvent,
    TextDocumentChangeEvent,
    TextDocument,
    Diagnostic,
    Range,
    DiagnosticSeverity,
    window,
} from "vscode";
import { Configuration } from "./configuration";
import { Settings } from "./interfaces/settings";
import { PHPCSReport, PHPCSMessageType, PHPCSFileStatus } from "./interfaces/phpcs-report";
import { SpawnArguments } from "./interfaces/spawn-options";
import { StandardsPathResolver } from "./resolvers/standards-path-resolver";
import { spawn } from "child_process";
import { debounce } from "lodash";
import { Logger } from "./logger";
import * as path from "path";

const enum runConfig {
    save = "onSave",
    type = "onType",
}

export class Sniffer {
    public config!: Settings;

    private diagnosticCollection: DiagnosticCollection = languages.createDiagnosticCollection(
        "php"
    );

    /**
     * The active validator listener.
     */
    private validatorListener?: Disposable;

    /**
     * Token to cancel a current validation runs.
     */
    private runnerCancellations: Map<Uri, CancellationTokenSource> = new Map();

    constructor(
        subscriptions: Disposable[],
        config: Settings,
        private logger: Logger
    ) {
        this.config = config;
        // if (config.resources[0].snifferEnable === false) {
        //     return;
        // }
        workspace.onDidChangeConfiguration(
            this.onConfigChange,
            this,
            subscriptions
        );
        workspace.onDidOpenTextDocument(this.validate, this, subscriptions);
        workspace.onDidCloseTextDocument(
            this.clearDocumentDiagnostics,
            this,
            subscriptions
        );
        workspace.onDidChangeWorkspaceFolders(
            this.refresh,
            this,
            subscriptions
        );

        this.refresh();
        this.setValidatorListener();
    }

    /**
     * Dispose this object.
     */
    public dispose(): void {
        this.diagnosticCollection.clear();
        this.diagnosticCollection.dispose();
    }

    /**
     * Reacts on configuration change.
     *
     * @param event - The configuration change event.
     */
    protected async onConfigChange(event: ConfigurationChangeEvent) {
        if (!event.affectsConfiguration("phpsab")) {
            return;
        }

        let configuration = new Configuration(this.logger);
        let config = await configuration.load();
        this.config = config;

        if (
            event.affectsConfiguration("phpsab.snifferMode") ||
            event.affectsConfiguration("phpsab.snifferTypeDelay")
        ) {
            this.setValidatorListener();
        }

        this.refresh();
    }

    /**
     * Sets the validation event listening.
     */
    protected setValidatorListener(): void {
        if (this.validatorListener) {
            this.validatorListener.dispose();
        }
        const run: runConfig = this.config.snifferMode as runConfig;
        const delay: number = this.config.snifferTypeDelay;

        if (run === (runConfig.type as string)) {
            const validator = debounce(
                ({ document }: TextDocumentChangeEvent): void => {
                    this.validate(document);
                },
                delay
            );
            this.validatorListener = workspace.onDidChangeTextDocument(
                validator
            );
        } else {
            this.validatorListener = workspace.onDidSaveTextDocument(
                this.validate,
                this
            );
        }
    }

    /**
     * Refreshes validation on any open documents.
     */
    protected refresh(): void {
        this.diagnosticCollection!.clear();

        workspace.textDocuments.forEach(this.validate, this);
    }

    /**
     * Clears diagnostics from a document.
     *
     * @param document - The document to clear diagnostics of.
     */
    protected clearDocumentDiagnostics({ uri }: TextDocument): void {
        this.diagnosticCollection.delete(uri);
    }

    /**
     * Build the arguments needed to execute sniffer
     * @param fileName
     * @param standard
     */
    private getArgs(document: TextDocument, standard: string, additionalArguments: string[]) {
        const uri = document.uri;
        const workspaceFolder = workspace.getWorkspaceFolder(uri);

        if (!workspaceFolder) {
            return [];
        }

        const resourceConf = this.config.resources[workspaceFolder.index];

        const isDockerEnabled: boolean = resourceConf.dockerEnabled || false;

        // Process linting paths.
        let filePath = document.fileName;

        if( isDockerEnabled ) {
            // get workspace root from workspace folder
            const workspaceRoot = workspaceFolder.uri.fsPath;
            // get the relative path to the file
            const relativePath = path.relative(workspaceRoot, uri.fsPath);
            const dockerWorkspaceRoot: string = resourceConf.dockerWorkspaceRoot || "";
            // replace workspace root with docker workspace root
            filePath = path.join(dockerWorkspaceRoot, relativePath);
        }

        let args = [];
        args.push("--report=json");
        args.push("-q");
        if (standard !== "") {
            args.push("--standard=" + standard);
        }
        args.push(`--stdin-path=${filePath}`);
        args.push("-");
        args = args.concat(additionalArguments);
        return args;
    }

    /**
     * Lints a document.
     *
     * @param document - The document to lint.
     */
    protected async validate(document: TextDocument) {
        const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            return;
        }
        const resourceConf = this.config.resources[workspaceFolder.index];
        if (
            document.languageId !== "php" ||
            resourceConf.snifferEnable === false
        ) {
            return;
        }
        this.logger.time("Sniffer");

        const additionalArguments = resourceConf.snifferArguments.filter((arg) => {
            if (arg.indexOf('--report') === -1 &&
                arg.indexOf('--standard') === -1 &&
                arg.indexOf('--stdin-path') === -1 &&
                arg !== '-q' &&
                arg !== '-'
            ) {
                return true;
            }

            return false;
        });

        const oldRunner = this.runnerCancellations.get(document.uri);
        if (oldRunner) {
            oldRunner.cancel();
            oldRunner.dispose();
        }

        const runner = new CancellationTokenSource();
        this.runnerCancellations.set(document.uri, runner);
        const { token } = runner;

        const standard = await new StandardsPathResolver(
            document,
            resourceConf,
            this.logger
        ).resolve();
        const lintArgs = this.getArgs(document, standard, additionalArguments);

        let fileText = document.getText();

        const options = {
            cwd:
                resourceConf.workspaceRoot !== null
                    ? resourceConf.workspaceRoot
                    : undefined,
            env: process.env,
            encoding: "utf8",
            tty: true,
        };
        this.logger.logInfo(
            "SNIFFER COMMAND: " +
                        resourceConf.executablePathCS +
                        " " +
                        lintArgs.join(" ")
        );

        // sniffer args can be different depending on if docker is enabled or not
        // how can i handle with this?

        const isDockerEnabled: boolean = resourceConf.dockerEnabled || false;

        const snifferArgs: SpawnArguments = {
            command: "",
            args: [],
            spawnOptions: options,
        };

        if( isDockerEnabled ) {
            const dockerContainer = resourceConf.dockerContainer || "";
            const dockerExecutablePathCS = resourceConf.dockerExecutablePathCS || "";
            const dockerCommand = ["exec", "-i", dockerContainer, dockerExecutablePathCS, ...lintArgs];
            snifferArgs.command = "docker";
            snifferArgs.args = dockerCommand;
        } else {
            snifferArgs.command = resourceConf.executablePathCS;
            snifferArgs.args = lintArgs;
        }
        const { command, args, spawnOptions } = snifferArgs;
        const sniffer = spawn(command, args, spawnOptions);
        sniffer.stdin.write(fileText);
        sniffer.stdin.end();

        let stdout = "";
        let stderr = "";

        sniffer.stdout.on("data", (data) => (stdout += data));
        sniffer.stderr.on("data", (data) => (stderr += data));

        const done = new Promise((resolve, reject) => {
            sniffer.on("close", () => {
                if (token.isCancellationRequested || !stdout) {
                    resolve();
                    return;
                }
                const diagnostics: Diagnostic[] = [];
                try {
                    const { files }: PHPCSReport = JSON.parse(stdout);
                    // typescript object with keys as strings and values as PHPCSFileStatus
                    const reMappedFiles = Object.entries(files).reduce((acc, [key, value]) => {
                        const workspaceRoot = resourceConf.workspaceRoot || "";
                        const dockerWorkspaceRoot = resourceConf.dockerWorkspaceRoot || "";
                        const remappedKey = key.replace(dockerWorkspaceRoot, workspaceRoot);
                        acc[remappedKey] = value;
                        return acc;
                    }, {} as { [key: string]: PHPCSFileStatus });
                    for (const file in reMappedFiles) {
                        reMappedFiles[file].messages.forEach(
                            ({ message, line, column, type, source }) => {
                                const zeroLine = line - 1;
                                const ZeroColumn = column - 1;

                                const range = new Range(
                                    zeroLine,
                                    ZeroColumn,
                                    zeroLine,
                                    ZeroColumn
                                );
                                const severity =
                                    type === PHPCSMessageType.ERROR
                                        ? DiagnosticSeverity.Error
                                        : DiagnosticSeverity.Warning;
                                let output = message;
                                if (this.config.snifferShowSources) {
                                    output += `\n(${source})`;
                                }
                                const diagnostic = new Diagnostic(
                                    range,
                                    output,
                                    severity
                                );
                                diagnostic.source = "phpcs";
                                diagnostics.push(diagnostic);
                            }
                        );
                    }
                    resolve();
                } catch (error) {
                    let message = "";
                    if (stdout) {
                        message += `${stdout}\n`;
                    }
                    if (stderr) {
                        message += `${stderr}\n`;
                    }
                    message += error.toString();
                    window.showErrorMessage(message);
                    this.logger.logError(message);
                    reject(message);
                }
                this.diagnosticCollection.set(document.uri, diagnostics);
                runner.dispose();
                this.runnerCancellations.delete(document.uri);
            });
        });

        window.setStatusBarMessage("PHP Sniffer: validating…", done);
        this.logger.timeEnd("Sniffer");
    }
}
