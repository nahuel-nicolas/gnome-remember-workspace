import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const STATE_FILE = GLib.get_home_dir() + '/.workspace-restore-state';
const DEBUG_FILE = GLib.get_home_dir() + '/.workspace-restore-debug.log';

function dbg(msg) {
    try {
        const file = Gio.File.new_for_path(DEBUG_FILE);
        const ts = new Date().toISOString();
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(`${ts} ${msg}\n`, null);
        stream.close(null);
    } catch(e) {}
}

function saveWorkspace(index) {
    try {
        const file = Gio.File.new_for_path(STATE_FILE);
        file.replace_contents(`${index}`, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        dbg(`Saved workspace ${index}`);
    } catch(e) { dbg(`Save error: ${e}`); }
}

function loadWorkspace() {
    try {
        const file = Gio.File.new_for_path(STATE_FILE);
        const [, contents] = file.load_contents(null);
        return parseInt(new TextDecoder().decode(contents).trim(), 10) || 0;
    } catch(e) {
        return -1;
    }
}

export default class WorkspaceRestoreExtension {
    #timerId = null;

    enable() {
        const saved = loadWorkspace();
        dbg(`enable() called, saved=${saved}, current=${global.workspace_manager.get_active_workspace_index()}`);
        if (saved >= 0) {
            this.#timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                const ws = global.workspace_manager.get_workspace_by_index(saved);
                dbg(`restoring to workspace ${saved}, current=${global.workspace_manager.get_active_workspace_index()}`);
                if (ws) ws.activate(global.get_current_time());
                this.#timerId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        if (this.#timerId !== null) {
            GLib.source_remove(this.#timerId);
            this.#timerId = null;
        }
        const current = global.workspace_manager.get_active_workspace_index();
        dbg(`disable() called, current=${current}`);
        saveWorkspace(current);
    }
}
