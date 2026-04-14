export type TemplateChild = {
  id: string;
  title: string;
  preview: string;
  pasteText: string;
  isSeparator?: boolean;
  /** Вложенные папки (подпункты) */
  children?: TemplateChild[];
};

export type TemplateRow = {
  id: string;
  title: string;
  preview: string;
  pasteText?: string;
  children?: TemplateChild[];
  isSeparator?: boolean;
};

export type AppConfig = {
  paletteHotkey: string;
  autostart: boolean;
  masterTemplatesPath: string | null;
};

export type PathsDto = {
  baseDir: string;
  masterDir: string;
  userDir: string;
  configPath: string;
  variablesPath: string;
  userStructurePath: string;
};

/** Элементы `user/structure.json` (порядок в палитре). */
export type UserStructureItem =
  | { type: "template"; file: string }
  | { type: "folder"; id: string; title: string; items: UserStructureItem[] }
  | { type: "separator"; id: string };

export type UserStructureRoot = {
  version: number;
  items: UserStructureItem[];
};

export type UserTxtReadDto = {
  file: string;
  title: string;
  content: string;
};

export type UserTxtWriteResultDto = {
  file: string;
};

export type UserTemplateCreateResultDto = {
  file: string;
};
