// node:stream для сайта: memfs ссылается на потоки, но AnimForge читает и пишет файлы целиком — потоки не нужны.
import { EventEmitter } from "events";

const no = () => {
  throw new Error("потоков на сайте нет");
};
export class Readable extends EventEmitter { constructor() { super(); no(); } }
export class Writable extends EventEmitter { constructor() { super(); no(); } }
export default { Readable, Writable };
