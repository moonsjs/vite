/** Nama virtual module PRD §9.4. Semua di-resolve ke id `\0`-prefix. */
export const VIRTUAL_MODULES = {
  routes: "virtual:moons/routes",
  api: "virtual:moons/api",
  config: "virtual:moons/config",
  clientEntry: "virtual:moons/client-entry",
  serverEntry: "virtual:moons/server-entry",
} as const;

export type VirtualModuleName = (typeof VIRTUAL_MODULES)[keyof typeof VIRTUAL_MODULES];

export function isVirtualModuleId(id: string): id is VirtualModuleName {
  const clean = id.startsWith("\0") ? id.slice(1) : id;
  return (Object.values(VIRTUAL_MODULES) as string[]).includes(clean);
}

export function toNullPrefixed(id: VirtualModuleName): `\0${string}` {
  return `\0${id}`;
}

export function fromNullPrefixed(id: string): VirtualModuleName | null {
  const clean = id.startsWith("\0") ? id.slice(1) : id;
  return isVirtualModuleId(clean) ? (clean as VirtualModuleName) : null;
}
