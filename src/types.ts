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

export type QuickLocation = { name: string; path: string };
export type ScreenshotFormat = "png" | "jpeg";
export type OcrQuality = "mobile" | "server";

export type OcrEngine = "system" | "paddle";

export type ScreenshotPresetAction = "save" | "ocr" | "pin";

export type ScreenshotPreset = {
  id: string;
  title: string;
  /** "" — хоткей не назначен (пресет доступен из трея и через API). */
  hotkey: string;
  /** "" — общая папка по умолчанию. */
  dir: string;
  /** "" — общий шаблон имени файла. */
  fileTemplate: string;
  action: ScreenshotPresetAction;
  /** true — через выделение области, false — весь экран. */
  select: boolean;
};

export type AppConfig = {
  paletteHotkey: string;
  autostart: boolean;
  theme: UiThemeSetting;
  paletteListDensity: PaletteListDensity;
  screenshotHotkey: string;
  screenshotFormat: ScreenshotFormat;
  screenshotJpegQuality: number;
  screenshotFileTemplate: string;
  screenshotSaveDir: string;
  screenshotQuickLocations: QuickLocation[];
  screenshotOcrEngine: OcrEngine;
  screenshotOcrLanguage: string;
  screenshotOcrQuality: OcrQuality;
  screenshotPresets: ScreenshotPreset[];
  apiEnabled: boolean;
  apiPort: number;
  aiApiKey: string;
  aiModel: string;
};

/** Одно сообщение чата ИИ-агента (история хранится на бэкене). */
export type AiChatMessage = {
  role: "user" | "assistant";
  text: string;
  /** Идентификаторы прикреплённых скриншотов (snipcast_ai_image по запросу). */
  imageIds: number[];
};

export type UpdateInfo = {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  notes: string;
  size: number;
};

export type PathsDto = {
  baseDir: string;
  configPath: string;
  variablesPath: string;
  filesDir: string;
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
