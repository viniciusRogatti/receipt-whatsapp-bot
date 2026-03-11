const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
]);

const ensureDir = async (targetDir) => {
  await fsPromises.mkdir(targetDir, { recursive: true });
  return targetDir;
};

const pathExists = async (targetPath) => {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const toSafeFileStem = (relativePath) => {
  return String(relativePath || '')
    .replace(/[\\/]+/g, '__')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'image';
};

const listImageFiles = async (rootDir) => {
  const exists = await pathExists(rootDir);
  if (!exists) return [];

  const walk = async (currentDir) => {
    const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walk(absolutePath));
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
        files.push(absolutePath);
      }
    }

    return files;
  };

  const files = await walk(rootDir);
  return files.sort((left, right) => left.localeCompare(right));
};

const writeJsonFile = async (targetPath, payload) => {
  await ensureDir(path.dirname(targetPath));
  await fsPromises.writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return targetPath;
};

const writeTextFile = async (targetPath, payload) => {
  await ensureDir(path.dirname(targetPath));
  await fsPromises.writeFile(targetPath, String(payload || ''), 'utf8');
  return targetPath;
};

const copyFile = async (sourcePath, targetPath) => {
  await ensureDir(path.dirname(targetPath));
  await fsPromises.copyFile(sourcePath, targetPath);
  return targetPath;
};

const moveFile = async (sourcePath, targetPath) => {
  await ensureDir(path.dirname(targetPath));

  try {
    await fsPromises.rename(sourcePath, targetPath);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      await fsPromises.copyFile(sourcePath, targetPath);
      await fsPromises.unlink(sourcePath);
    } else {
      throw error;
    }
  }

  return targetPath;
};

const readJsonFile = async (targetPath) => {
  const raw = await fsPromises.readFile(targetPath, 'utf8');
  return JSON.parse(raw);
};

const removeFile = async (targetPath) => {
  try {
    await fsPromises.unlink(targetPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
};

module.exports = {
  SUPPORTED_IMAGE_EXTENSIONS,
  copyFile,
  ensureDir,
  listImageFiles,
  moveFile,
  pathExists,
  readJsonFile,
  removeFile,
  toSafeFileStem,
  writeJsonFile,
  writeTextFile,
};
