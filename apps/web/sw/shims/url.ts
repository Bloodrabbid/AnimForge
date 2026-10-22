// node:url для сайта: исходники «лежат» в /af как в репозитории. Все, кто зовёт fileURLToPath(import.meta.url), сидят
// в packages/cli/src — от них ядро считает ROOT и папку пресетов.
export const fileURLToPath = (_u: string | URL) => "/af/packages/cli/src/node.ts";
export const pathToFileURL = (p: string) => new URL(`file://${p}`);
export default { fileURLToPath, pathToFileURL };
