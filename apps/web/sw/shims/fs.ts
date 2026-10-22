// node:fs для сайта: файловая система в памяти (memfs). Репозиторий лежит в /af — его наполняет sw.ts.
import { Volume, createFsFromVolume } from "memfs";

export const vol = new Volume();
const fs: any = createFsFromVolume(vol);
export default fs;
export const promises = fs.promises;
export const existsSync = fs.existsSync.bind(fs);
export const readFileSync = fs.readFileSync.bind(fs);
export const writeFileSync = fs.writeFileSync.bind(fs);
export const mkdirSync = fs.mkdirSync.bind(fs);
export const mkdtempSync = fs.mkdtempSync.bind(fs);
export const readdirSync = fs.readdirSync.bind(fs);
export const rmSync = fs.rmSync.bind(fs);
export const statSync = fs.statSync.bind(fs);
export const copyFileSync = fs.copyFileSync.bind(fs);
export const cpSync = fs.cpSync.bind(fs);
export const renameSync = fs.renameSync.bind(fs);
export const unlinkSync = fs.unlinkSync.bind(fs);
export const createReadStream = fs.createReadStream.bind(fs);
/** слежения за файлами на сайте нет — проект меняет только сама страница */
export const watch = () => ({ close() {} });
