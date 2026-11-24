// Fixture data of the OpenCode web tests: the shape of `opencode_models`, trimmed (synthetic ids and
// numbers, never a real account or vault).
import type { OpencodeModel } from "../web/ipc";
import { toBackendModel } from "../web/lib/models";

const base: OpencodeModel = {
  id: "",
  providerId: "",
  provider: "",
  name: "",
  context: 200_000,
  inputCost: 3,
  outputCost: 15,
  free: false,
  image: false,
  pdf: false,
  tools: true,
  reasoning: false,
  variants: [],
  available: true,
};

const model = (over: Partial<OpencodeModel>): OpencodeModel => ({ ...base, ...over });

export const MODELS: OpencodeModel[] = [
  model({
    id: "acme/big-1",
    providerId: "acme",
    provider: "Acme AI",
    name: "Big One",
    context: 1_000_000,
    inputCost: 0.3,
    outputCost: 2.5,
    image: true,
    pdf: true,
    reasoning: true,
    variants: ["none", "low", "high", "max"],
  }),
  model({
    id: "acme/small-1",
    providerId: "acme",
    provider: "Acme AI",
    name: "Small One",
    context: 128_000,
    inputCost: 0.1,
    outputCost: 0.4,
  }),
  model({
    id: "zed/free-1",
    providerId: "zed",
    provider: "Zed Labs",
    name: "Freebie",
    free: true,
    inputCost: 0,
    outputCost: 0,
    variants: ["minimal", "medium"],
    reasoning: true,
  }),
  model({
    id: "zed/retired-1",
    providerId: "zed",
    provider: "Zed Labs",
    name: "Retired",
    available: false,
    inputCost: null,
    outputCost: null,
    context: null,
  }),
];

export const BACKEND_MODELS = MODELS.map(toBackendModel);

export const STATUS_READY = {
  found: true,
  path: "/synthetic/bin/opencode",
  version: "2.4.0",
  supported: true,
  minVersion: "2.4.0",
};
