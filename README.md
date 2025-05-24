# OBS Reactive replay

This is a LUA script for [OBS](https://obsproject.com/).
Whenever the replay buffer is saved to disk,
then script updates the path of an ffmpeg- or VLC-media-source.
The next time you cut to this media source,
the most recent replay will be played.

## OBS preparation

1. Create a new _Scene_.
1. Add a new _Media Source_.
   - Call it _Replay Video_ or any other name you like.
1. Select any random video file as source.
1. Open the OBS Settings
1. Enable the _Replay Buffer_ in _Output_
1. Enable the option _Automatically start replay buffer when streaming_ in _General_.
1. Close the settings with _OK_.

Now, OBS will create a replay buffer (in memory).
Whenever you click the _Save replay buffer_ icon,
or when that action is triggered via a shortcut or
via [Companion](https://bitfocus.io/companion),
that replay buffer is written to disk.

## Script Installation

1. Download the `reactive-replay.lua` file to a place on your computer.
1. In OBS, open the _script management window_
   - On macOS, that's under _Tools_ → _Scripts_
1. Click the `+` button
1. Select the file `reactive-replay.lua`, which you just downloaded.
1. Choose the _Media Source_ you previously created on the right.

Now, whenever OBS writes the replay buffer to disk,
the _Media Source_ which you've chosen is updated.
The path of the media file will point to the most recent replay video file.

## License

Licensed under [GNU GPL 2.0](./LICENSE).
