# Image compression

Sends the model smaller copies of large images: a screenshot's PNG goes as a JPEG of 300 KB or less, so more images
fit what a provider takes (GitHub Copilot's few MB) before Superego has to leave older ones out. Only the request
changes: the thread keeps the originals.

Off by default. Turn it on in Settings → Image compression (`Compress large images`), and set the size there
(`Larger than (KB)`, 300 unless changed). From the command line:

```sh
superego do settings.set --key image-compression.on --value true
```

- `daemon.ts`: a `beforeRequest` hook on each request (`hook(GenerationTask, …)`), fitting each image over the size
  with Superego's own fitting (`superego.images.fit`): PNG, then JPEG at falling qualities, then smaller. Each image is
  compressed once per size and kept for the next request (64 MB at most).
- `image-compression.test.ts`: `superego extension test image-compression --user`.

Needs extension API 5.12. On an older Superego it says so in the daemon's log and does nothing; the profile still loads.
