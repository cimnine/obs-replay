# OBS Reactive Replay

A browser replay desk for [OBS Studio](https://obsproject.com/).
Save replay clips, preview them locally, and queue a clip in a Media Source or VLC Video Source.
Cut to the replay scene in OBS to play the queued clip.
You can also enable instant replay to queue each new save automatically.

## OBS preparation

1. Open **Settings → Output** in OBS.
1. Enable the **Replay Buffer** and choose how much replay time to keep.
1. Check the recording path in **Output**.
   This is the folder you will select for browser previews.
1. Close Settings with **OK**.
1. Click **Start Replay Buffer** in OBS.
   You can also enable **Automatically start replay buffer when streaming** under **Settings → General**.
1. Open **Tools → WebSocket Server Settings**.
1. Enable the WebSocket server and note its port and password.
   The page requires OBS WebSocket 5 or newer.

The replay buffer keeps recent video in memory.
Saving the buffer writes a clip to disk.
You can save from the page, from OBS, with an OBS hotkey, or through [Companion](https://bitfocus.io/companion).

## Open the replay desk

Open [replay-dock.html](./replay-dock.html) in a browser to browse a grid of saved replays.
The file includes all styles and JavaScript.
It needs no installation, internet connection, or local web server.
You can also add its absolute `file:///…/replay-dock.html` URL under **Docks → Custom Browser Docks** in OBS.

### Connect and choose a replay target

1. In the replay desk’s **Settings**, enter the server address and password.
   The default address is `ws://127.0.0.1:4455`.
1. Click **Connect to OBS**.
1. Choose the replay scene and its Media Source or VLC Video Source.
   The desk first restores your previously selected scene from local storage.
   Otherwise, it looks for an existing scene with `replay` in its name.
   If no scene matches, enter a scene name and click **Create scene + media source**.
   You can also select any existing scene from the dropdown.
   If that scene has no Media or VLC source, click **Add replay media source**.
   Use **Type for new replay sources** to choose which type to create.
   Creating VLC sources requires VLC support to be available in OBS.

### Save, preview, and play a replay

1. Click **Choose replay folder** in Settings and select the OBS recording folder.
   Use a browser on the OBS computer to preview its local files.
1. Click **Save replay buffer** in the page or save it from OBS.
   Wait for the saved clip to appear in the grid.
1. Click a clip’s thumbnail or **Preview** to inspect it in the browser.
1. Click **Queue in OBS** to load the clip into the selected source.
   Enable **Instant replay: automatically queue the latest saved replay** in Settings to queue new saves automatically.
1. Cut to the replay scene in OBS to play it.

If you previously installed `reactive-replay.lua`, remove it from **Tools → Scripts** or disable its automatic source updates.
Otherwise, a new save can replace the clip you chose.

Queuing does not switch scenes.
The desk refuses to update a source that OBS reports as active in Program.

Instant replay is off by default and remembers your choice across reloads.
It applies to new saves while connected, including saves triggered in OBS or by a shortcut.
It does not queue existing history when enabled or the last replay retrieved on connection.

If the source is active, the replay stays in the grid and an error appears.
Cut away from the source, then queue the clip manually.

For Media Sources, queuing replaces the local file.
For VLC sources, it replaces the entire playlist with the selected replay.
Both types restart when activated, with looping disabled.
Scene creation also leaves the live scene unchanged.

### Preview access

OBS WebSocket supplies file paths, not video data.
The browser needs permission to read the clips.
After choosing the replay folder, grid cards load video frames as thumbnails without playing audio.

Clips on hidden pages load when you browse to them.
Browsers with directory access can open new files from the chosen folder during the page session.
This requires `showDirectoryPicker`, supported in desktop Chrome 86+, Edge 86+, and Opera 72+.
Firefox and Safari do not support this API.
See [MDN browser compatibility](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker#browser_compatibility) for other platforms.

The API requires a secure context and can also be restricted by the page’s embedding context.
The desk shows a warning when the API is missing or the browser blocks folder access.
Other browsers use a folder snapshot, which you must select again after saving more clips.

You can always use **Choose preview file** for an individual clip.
Choose the file that corresponds to the saved OBS path.
If a folder contains several files with the same name, use the individual file picker to resolve ambiguity.
File permissions must be granted again after reloading the page.

Preview support depends on the browser’s video codecs.
H.264 MP4 is a practical choice for browser previews.
MKV and HEVC files may play in OBS while failing in a browser.
The desk shows playback errors without preventing queuing.

### Saved settings and history

The desk stores the server address, password, selected scene, selected media source, visibility settings, and all tracked replay paths in local storage.

- The password is restored when the page opens.
- The settings panel returns to its last open or minimized state after a reload.
- **Automatically reconnect** is enabled by default and saved with the connection settings.
- The desk reconnects to the saved server after a page reload or connection loss if the last action was **Connect**.
  Failed attempts use exponential backoff: 1, 2, 4, 8, 16, then 30 seconds between attempts.
  A successful connection resets the delay.
  Click **Disconnect** to stop retries and remain disconnected after reloading the page.
- The last **Connect** or **Disconnect** action is saved separately from the automatic reconnection setting.
  Disable **Automatically reconnect** to prevent automatic connections and retries.
- History is separated by WebSocket address.
  Each window maintains its own history and selection.

Browser storage for local files can vary, especially in embedded browser docks.
If storage is unavailable, settings and history last only for the page session.

The grid includes replays saved while connected, plus the last saved replay reported by OBS on connection.
It does not scan the disk for older replays or recover saves missed while disconnected.
All tracked paths are retained without a fixed history limit, subject to browser storage capacity.

By default, the grid shows the newest 20 clips.
In Settings, choose whether to keep a number of clips visible or show clips from the last few minutes, for example 5 minutes.
Older clips move into **Hidden** automatically.

Use **Hidden** to browse them in pages of 24 clips, with the same preview and queuing actions.
Changing the visibility rules never removes history.

**Clear history** forgets the tracked paths for the current WebSocket address.
It never deletes video files.
If storage fills up, the desk warns you and keeps tracking in memory for the current session.

Use a dedicated Media Source or VLC Video Source directly inside the replay scene.
Nested scenes and grouped sources are not supported by the browser desk.

### Development checks

Run the WebSocket and replay workflow tests with Node.js 18 or newer:

```sh
node --test tests/replay-dock.test.cjs
```

## License

Licensed under the [GNU Affero General Public License, version 3.0](./LICENSE) (`AGPL-3.0-only`).
