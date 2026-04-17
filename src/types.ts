export type TemplateChild = {
  id: string;
  title: string;
  preview: string;
  pasteText: string;
  groupId?: string;
  isSeparator?: boolean;
  /** Вложенные папки (подпункты) */
  children?: TemplateChild[];
};

export type TemplateRow = {
  id: string;
  title: string;
  preview: string;
  pasteText?: string;
  groupId?: string;
  groupTitle?: string;
  groupColor?: string;
  children?: TemplateChild[];
  isSeparator?: boolean;
};

export type UiThemeSetting = "light" | "dark" | "system";
export type PaletteListDensity = "normal" | "compact";

export type AppConfig = {
  paletteHotkey: string;
  autostart: boolean;
  theme: UiThemeSetting;
  paletteListDensity: PaletteListDensity;
};

export type PathsDto = {
  baseDir: string;
  configPath: string;
  variablesPath: string;
};

export type TemplateNode =
  | { type: "template"; id: string; title: string; content: string }
  | { type: "folder"; id: string; title: string; items: TemplateNode[] }
  | { type: "separator"; id: string };

export type TemplateGroup = {
  id: string;
  title: string;
  color: string;
  isMaster: boolean;
  /** Абсолютный путь к JSON мастер-группы (не копируется в папку шаблонов). */
  masterSourcePath?: string | null;
  items: TemplateNode[];
};

export type TemplateStore = {
  version: number;
  groups: TemplateGroup[];
};
