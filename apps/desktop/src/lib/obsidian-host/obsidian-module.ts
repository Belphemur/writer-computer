// Adapted from opensidian (GPL-3.0-or-later).
// Assembles the object `require("obsidian")` returns. Classes are wrapped so that ES5-style
// TypeScript output (`_super.apply(this, arguments)`) can subclass them: an ES class throws when
// called without `new`, so each exported class is a plain function sharing the class prototype.
import { App } from "./api/app";
import { Component, Events, Keymap, Notice, Plugin, Scope } from "./api/core";
import {
  addIcon,
  apiVersion,
  debounce,
  getIcon,
  getIconIds,
  getLinkpath,
  moment,
  normalizePath,
  parseFrontMatterAliases,
  parseFrontMatterEntry,
  parseFrontMatterTags,
  parseLinktext,
  parseYaml,
  Platform,
  prepareFuzzySearch,
  prepareSimpleSearch,
  removeIcon,
  renderMatches,
  request,
  requestUrl,
  requireApiVersion,
  sanitizeHTMLToDom,
  setIcon,
  stringifyYaml,
} from "./api/functions";
import {
  BasesEntry,
  BasesEntryGroup,
  BasesView,
  BasesViewConfig,
  QueryController,
} from "./api/bases-view";
import {
  BooleanValue,
  DateValue,
  DurationValue,
  ErrorValue,
  FileValue,
  HTMLValue,
  IconValue,
  ImageValue,
  LinkValue,
  ListValue,
  NullValue,
  NumberValue,
  ObjectValue,
  PrimitiveValue,
  RegExpValue,
  StringValue,
  UrlValue,
  Value,
} from "./api/bases-values";
import { MarkdownRenderChild, MarkdownRenderer } from "./api/markdown";
import {
  AbstractInputSuggest,
  BaseComponent,
  ButtonComponent,
  ColorComponent,
  DropdownComponent,
  EditorSuggest,
  ExtraButtonComponent,
  FuzzySuggestModal,
  Menu,
  MenuItem,
  Modal,
  PluginSettingTab,
  PopoverSuggest,
  SearchComponent,
  Setting,
  SettingTab,
  SliderComponent,
  SuggestModal,
  TextAreaComponent,
  TextComponent,
  ToggleComponent,
  ValueComponent,
} from "./api/ui";
import {
  DataAdapter,
  FileSystemAdapter,
  getAllTags,
  MetadataCache,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
} from "./api/vault";
import {
  EditableFileView,
  Editor,
  FileView,
  ItemView,
  MarkdownView,
  TextFileView,
  View,
  Workspace,
  WorkspaceLeaf,
} from "./api/views";

/* eslint-disable @typescript-eslint/no-explicit-any */

function es5<C extends abstract new (...args: any[]) => unknown>(Cls: C): C {
  function F(this: unknown, ...args: unknown[]): unknown {
    const nt: unknown = new.target ?? (this && (this as { constructor: unknown }).constructor) ?? F;
    return Reflect.construct(Cls as never, args, nt === F ? (Cls as never) : (nt as never));
  }
  Object.defineProperty(F, "name", { value: Cls.name });
  (F as unknown as { prototype: unknown }).prototype = Cls.prototype;
  Object.setPrototypeOf(F, Cls); // statics (Menu.forEvent) inherit
  return F as unknown as C;
}

const CLASSES = {
  App,
  BasesEntry,
  BasesEntryGroup,
  BasesView,
  BasesViewConfig,
  BooleanValue,
  DateValue,
  DurationValue,
  ErrorValue,
  FileValue,
  HTMLValue,
  IconValue,
  ImageValue,
  LinkValue,
  ListValue,
  NullValue,
  NumberValue,
  ObjectValue,
  PrimitiveValue,
  QueryController,
  RegExpValue,
  StringValue,
  UrlValue,
  Value,
  BaseComponent,
  ButtonComponent,
  ColorComponent,
  Component,
  DataAdapter,
  DropdownComponent,
  AbstractInputSuggest,
  EditableFileView,
  Editor,
  EditorSuggest,
  Events,
  ExtraButtonComponent,
  FileSystemAdapter,
  FileView,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderChild,
  MarkdownView,
  Menu,
  MenuItem,
  MetadataCache,
  Modal,
  Plugin,
  PluginSettingTab,
  PopoverSuggest,
  Scope,
  SearchComponent,
  Setting,
  SettingTab,
  SliderComponent,
  SuggestModal,
  TAbstractFile,
  TextAreaComponent,
  TextComponent,
  TextFileView,
  TFile,
  TFolder,
  ToggleComponent,
  ValueComponent,
  Vault,
  View,
  Workspace,
  WorkspaceLeaf,
};

export type ObsidianModule = Readonly<Record<string, unknown>>;

/** The shared, frozen `obsidian` module. Per-vault state lives on the `App` plugins receive. */
export function createObsidianModule(): ObsidianModule {
  const wrapped: Record<string, unknown> = {};
  for (const [name, cls] of Object.entries(CLASSES)) wrapped[name] = es5(cls as never);
  return Object.freeze({
    ...wrapped,
    // Not wrapped: Keymap and Notice have static members plugins read and are not subclassed in ES5.
    Keymap,
    Notice,
    MarkdownRenderer,
    Platform,
    apiVersion,
    requireApiVersion,
    addIcon,
    removeIcon,
    getIcon,
    getIconIds,
    setIcon,
    debounce,
    normalizePath,
    parseYaml,
    stringifyYaml,
    parseLinktext,
    getLinkpath,
    parseFrontMatterEntry,
    parseFrontMatterAliases,
    parseFrontMatterTags,
    getAllTags,
    prepareFuzzySearch,
    prepareSimpleSearch,
    renderMatches,
    requestUrl,
    request,
    sanitizeHTMLToDom,
    moment,
  });
}
