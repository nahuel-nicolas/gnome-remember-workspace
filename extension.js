import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const STATE_FILE = GLib.get_home_dir() + '/.workspace-restore-state';

function rectToObj(r) {
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}

function isNormalWindow(win) {
    return !win.is_skip_taskbar() && win.get_window_type() === Meta.WindowType.NORMAL;
}

function captureState() {
    const windows = [];
    // list_all_windows() returns windows top-to-bottom (focused first).
    // Saving in this order lets restore process them in reverse to rebuild z-order.
    for (const win of global.display.list_all_windows()) {
        if (!isNormalWindow(win)) continue;
        const rect = win.get_frame_rect();
        windows.push({
            id: win.get_id(),
            workspace: win.get_workspace()?.index() ?? -1,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            maximized: win.get_maximized(),
            minimized: win.minimized,
            isTiled: win.isTiled ?? false,
            tiledRect: rectToObj(win.tiledRect),
            untiledRect: rectToObj(win.untiledRect),
        });
    }
    return {
        activeWs: global.workspace_manager.get_active_workspace_index(),
        focusedId: global.display.focus_window?.get_id() ?? null,
        windows,
    };
}

function saveState() {
    try {
        const state = captureState();
        const file = Gio.File.new_for_path(STATE_FILE);
        file.replace_contents(JSON.stringify(state), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch(e) { logError(e, '[workspace-restore] save failed'); }
}

function loadState() {
    try {
        const file = Gio.File.new_for_path(STATE_FILE);
        const [, contents] = file.load_contents(null);
        return JSON.parse(new TextDecoder().decode(contents));
    } catch(e) { return null; }
}

export default class WorkspaceRestoreExtension {
    #restoreTimerId = null;
    #saveTimerId = null;

    async enable() {
        const state = loadState();

        saveState();
        this.#saveTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 10, () => {
            saveState();
            return GLib.SOURCE_CONTINUE;
        });

        if (!state) return;

        let twm = null;
        let Rect = null;
        try {
            const taExt = Main.extensionManager._extensions?.get('tiling-assistant@ubuntu.com');
            if (taExt?.path && taExt?.stateObj?._twm) {
                twm = taExt.stateObj._twm;
                ({ Rect } = await import(`file://${taExt.path}/src/extension/utility.js`));
            }
        } catch(e) {
            logError(e, '[workspace-restore] tiling-assistant unavailable, using fallback');
        }

        // Bail if disable() was called while awaiting the import
        if (this.#saveTimerId === null) return;

        this.#restoreTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
            const ws = global.workspace_manager.get_workspace_by_index(state.activeWs);
            if (ws) ws.activate(global.get_current_time());

            const winMap = new Map();
            for (const win of global.display.list_all_windows()) {
                if (isNormalWindow(win)) winMap.set(win.get_id(), win);
            }

            // state.windows is top-to-bottom (focused first). Process in reverse so
            // the focused window is raised last and ends up on top.
            const ordered = [...state.windows].reverse();

            for (const saved of ordered) {
                const win = winMap.get(saved.id);
                if (!win) continue;

                if (win.get_maximized()) win.unmaximize(Meta.MaximizeFlags.BOTH);

                if (saved.maximized) {
                    win.maximize(saved.maximized);
                } else if (saved.isTiled && twm && Rect && saved.tiledRect) {
                    // Non-focused tiled windows: fakeTile=true positions without connecting
                    // tile-group raise signals, avoiding z-order cascade. The focused tiled
                    // window (processed last) gets a full tile() which builds the group and
                    // raises it on top cleanly.
                    const isFocused = saved.id === state.focusedId;
                    twm.tile(win, new Rect(saved.tiledRect), { openTilingPopup: false, skipAnim: true, fakeTile: !isFocused });
                    win.untiledRect = saved.untiledRect ? new Meta.Rectangle(saved.untiledRect) : null;
                } else {
                    win.move_resize_frame(true, saved.x, saved.y, saved.width, saved.height);
                    win.isTiled = saved.isTiled;
                    win.tiledRect = saved.tiledRect ? new Meta.Rectangle(saved.tiledRect) : null;
                    win.untiledRect = saved.untiledRect ? new Meta.Rectangle(saved.untiledRect) : null;
                    // Raise non-tiled windows explicitly; tile() handles raise internally
                    if (!saved.minimized) {
                        if (win.raise_and_make_recent_on_workspace)
                            win.raise_and_make_recent_on_workspace(global.workspace_manager.get_active_workspace());
                        else
                            win.raise_and_make_recent();
                    }
                }

                // tile() calls unminimize() internally; re-minimize if needed
                if (saved.minimized && !win.minimized) win.minimize();
                else if (!saved.minimized && win.minimized) win.unminimize();
            }

            this.#restoreTimerId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this.#restoreTimerId !== null) {
            GLib.source_remove(this.#restoreTimerId);
            this.#restoreTimerId = null;
        }
        if (this.#saveTimerId !== null) {
            GLib.source_remove(this.#saveTimerId);
            this.#saveTimerId = null;
        }
    }
}
