"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MacUpdater = void 0;
const builder_util_runtime_1 = require("builder-util-runtime");
const fs_extra_1 = require("fs-extra");
const fs_1 = require("fs");
const http_1 = require("http");
const AppUpdater_1 = require("./AppUpdater");
const Provider_1 = require("./providers/Provider");
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
class MacUpdater extends AppUpdater_1.AppUpdater {
    constructor(options, app) {
        super(options, app);
        this.nativeUpdater = require("electron").autoUpdater;
        this.squirrelDownloadedUpdate = false;
        this.nativeUpdater.on("error", it => {
            this._logger.warn(it);
            this.emit("error", it);
        });
        this.nativeUpdater.on("update-downloaded", () => {
            this.squirrelDownloadedUpdate = true;
        });
    }
    debug(message) {
        if (this._logger.debug != null) {
            this._logger.debug(message);
        }
    }
    async doDownloadUpdate(downloadUpdateOptions) {
        let files = downloadUpdateOptions.updateInfoAndProvider.provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info);
        const log = this._logger;
        // detect if we are running inside Rosetta emulation
        const sysctlRosettaInfoKey = "sysctl.proc_translated";
        let isRosetta = false;
        try {
            this.debug("Checking for macOS Rosetta environment");
            const result = (0, child_process_1.execFileSync)("sysctl", [sysctlRosettaInfoKey], { encoding: "utf8" });
            isRosetta = result.includes(`${sysctlRosettaInfoKey}: 1`);
            log.info(`Checked for macOS Rosetta environment (isRosetta=${isRosetta})`);
        }
        catch (e) {
            log.warn(`sysctl shell command to check for macOS Rosetta environment failed: ${e}`);
        }
        let isArm64Mac = false;
        try {
            this.debug("Checking for arm64 in uname");
            const result = (0, child_process_1.execFileSync)("uname", ["-a"], { encoding: "utf8" });
            const isArm = result.includes("ARM");
            log.info(`Checked 'uname -a': arm64=${isArm}`);
            isArm64Mac = isArm64Mac || isArm;
        }
        catch (e) {
            log.warn(`uname shell command to check for arm64 failed: ${e}`);
        }
        isArm64Mac = isArm64Mac || process.arch === "arm64" || isRosetta;
        // allow arm64 macs to install universal or rosetta2(x64) - https://github.com/electron-userland/electron-builder/pull/5524
        const isArm64 = (file) => { var _a; return file.url.pathname.includes("arm64") || ((_a = file.info.url) === null || _a === void 0 ? void 0 : _a.includes("arm64")); };
        if (isArm64Mac && files.some(isArm64)) {
            files = files.filter(file => isArm64Mac === isArm64(file));
        }
        else {
            files = files.filter(file => !isArm64(file));
        }
        const zipFileInfo = (0, Provider_1.findFile)(files, "zip", ["pkg", "dmg"]);
        if (zipFileInfo == null) {
            throw (0, builder_util_runtime_1.newError)(`ZIP file not provided: ${(0, builder_util_runtime_1.safeStringifyJson)(files)}`, "ERR_UPDATER_ZIP_FILE_NOT_FOUND");
        }
        return this.executeDownload({
            fileExtension: "zip",
            fileInfo: zipFileInfo,
            downloadUpdateOptions,
            task: (destinationFile, downloadOptions) => {
                return this.httpExecutor.download(zipFileInfo.url, destinationFile, downloadOptions);
            },
            done: event => this.updateDownloaded(zipFileInfo, event),
        });
    }
    async updateDownloaded(zipFileInfo, event) {
        var _a, _b;
        const downloadedFile = event.downloadedFile;
        const updateFileSize = (_a = zipFileInfo.info.size) !== null && _a !== void 0 ? _a : (await (0, fs_extra_1.stat)(downloadedFile)).size;
        const log = this._logger;
        const logContext = `fileToProxy=${zipFileInfo.url.href}`;
        this.debug(`Creating proxy server for native Squirrel.Mac (${logContext})`);
        (_b = this.server) === null || _b === void 0 ? void 0 : _b.close();
        this.server = (0, http_1.createServer)();
        this.debug(`Proxy server for native Squirrel.Mac is created (${logContext})`);
        this.server.on("close", () => {
            log.info(`Proxy server for native Squirrel.Mac is closed (${logContext})`);
        });
        // must be called after server is listening, otherwise address is null
        const getServerUrl = (s) => {
            const address = s.address();
            if (typeof address === "string") {
                return address;
            }
            return `http://127.0.0.1:${address === null || address === void 0 ? void 0 : address.port}`;
        };
        return await new Promise((resolve, reject) => {
            const pass = (0, crypto_1.randomBytes)(64).toString("base64").replace(/\//g, "_").replace(/\+/g, "-");
            const authInfo = Buffer.from(`autoupdater:${pass}`, "ascii");
            // insecure random is ok
            const fileUrl = `/${(0, crypto_1.randomBytes)(64).toString("hex")}.zip`;
            this.server.on("request", (request, response) => {
                const requestUrl = request.url;
                log.info(`${requestUrl} requested`);
                if (requestUrl === "/") {
                    // check for basic auth header
                    if (!request.headers.authorization || request.headers.authorization.indexOf("Basic ") === -1) {
                        response.statusCode = 401;
                        response.statusMessage = "Invalid Authentication Credentials";
                        response.end();
                        log.warn("No authenthication info");
                        return;
                    }
                    // verify auth credentials
                    const base64Credentials = request.headers.authorization.split(" ")[1];
                    const credentials = Buffer.from(base64Credentials, "base64").toString("ascii");
                    const [username, password] = credentials.split(":");
                    if (username !== "autoupdater" || password !== pass) {
                        response.statusCode = 401;
                        response.statusMessage = "Invalid Authentication Credentials";
                        response.end();
                        log.warn("Invalid authenthication credentials");
                        return;
                    }
                    const data = Buffer.from(`{ "url": "${getServerUrl(this.server)}${fileUrl}" }`);
                    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": data.length });
                    response.end(data);
                    return;
                }
                if (!requestUrl.startsWith(fileUrl)) {
                    log.warn(`${requestUrl} requested, but not supported`);
                    response.writeHead(404);
                    response.end();
                    return;
                }
                log.info(`${fileUrl} requested by Squirrel.Mac, pipe ${downloadedFile}`);
                let errorOccurred = false;
                response.on("finish", () => {
                    if (!errorOccurred) {
                        this.nativeUpdater.removeListener("error", reject);
                        resolve([]);
                    }
                });
                const readStream = (0, fs_1.createReadStream)(downloadedFile);
                readStream.on("error", error => {
                    try {
                        response.end();
                    }
                    catch (e) {
                        log.warn(`cannot end response: ${e}`);
                    }
                    errorOccurred = true;
                    this.nativeUpdater.removeListener("error", reject);
                    reject(new Error(`Cannot pipe "${downloadedFile}": ${error}`));
                });
                response.writeHead(200, {
                    "Content-Type": "application/zip",
                    "Content-Length": updateFileSize,
                });
                readStream.pipe(response);
            });
            this.debug(`Proxy server for native Squirrel.Mac is starting to listen (${logContext})`);
            this.server.listen(0, "127.0.0.1", () => {
                this.debug(`Proxy server for native Squirrel.Mac is listening (address=${getServerUrl(this.server)}, ${logContext})`);
                this.nativeUpdater.setFeedURL({
                    url: getServerUrl(this.server),
                    headers: {
                        "Cache-Control": "no-cache",
                        Authorization: `Basic ${authInfo.toString("base64")}`,
                    },
                });
                // The update has been downloaded and is ready to be served to Squirrel
                this.dispatchUpdateDownloaded(event);
                if (this.autoInstallOnAppQuit) {
                    this.nativeUpdater.once("error", reject);
                    // This will trigger fetching and installing the file on Squirrel side
                    this.nativeUpdater.checkForUpdates();
                }
                else {
                    resolve([]);
                }
            });
        });
    }
    quitAndInstall() {
        var _a;
        if (this.squirrelDownloadedUpdate) {
            // update already fetched by Squirrel, it's ready to install
            this.nativeUpdater.quitAndInstall();
            (_a = this.server) === null || _a === void 0 ? void 0 : _a.close();
        }
        else {
            // Quit and install as soon as Squirrel get the update
            this.nativeUpdater.on("update-downloaded", () => {
                var _a;
                this.nativeUpdater.quitAndInstall();
                (_a = this.server) === null || _a === void 0 ? void 0 : _a.close();
            });
            if (!this.autoInstallOnAppQuit) {
                /**
                 * If this was not `true` previously then MacUpdater.doDownloadUpdate()
                 * would not actually initiate the downloading by electron's autoUpdater
                 */
                this.nativeUpdater.checkForUpdates();
            }
        }
    }
}
exports.MacUpdater = MacUpdater;
//# sourceMappingURL=MacUpdater.js.map