export type TemplateChild = {
  id: string;
  title: string;
  preview: string;
  pasteText: string;
};

export type TemplateRow = {
  id: string;
  title: string;
  preview: string;
  pasteText?: string;
  children?: TemplateChild[];
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
};

export type UserTemplateFile = {
  name: string;
  content: string;
};
