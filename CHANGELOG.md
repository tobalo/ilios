# Changelog

All notable changes to Ilios API will be documented in this file.

## [Unreleased]

### Performance

- **Worker file I/O**: Replaced Node.js `fs/promises` with Bun's native file APIs in worker threads for 3-5x faster file operations
  - `Bun.file().arrayBuffer()` replaces `fs.readFile()` with complex buffer manipulation
  - `Bun.file().delete()` replaces `fs.unlink()`
  - Better memory efficiency with lazy file loading

- **Convert endpoint**: Removed unnecessary directory creation syscall
  - Leverages Bun.write's automatic parent directory creation
  - Cleaner code with one less import and syscall per large file

### Changed

- Cleaned up verbose documentation files

## Previous Releases

See git history for changes in previous versions.
