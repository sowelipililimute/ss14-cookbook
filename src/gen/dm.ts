import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SpriteAttribution, SpritePoint } from '../types';
import { buildSpriteSheet } from './build-spritesheet';
import { ConstructRecipeBuilder } from './construct-recipe-builder';
import { EntityId, ReagentId } from './prototypes';
import { ResolvedGameData } from './resolve-prototypes';
import { Special } from './resolve-specials';
import { ProcessedGameData } from './save-data';
import {
  MicrowaveRecipeTypes,
  ResolvedEntity,
  ResolvedMicrowaveRecipe,
  ResolvedReactionRecipe,
  ResolvedRecipe,
  ResolvedReagent,
} from './types';

export interface DmSpriteRef {
  readonly rsi: string;
  readonly state: string;
}

export interface DmApplianceInfo {
  readonly sprite: DmSpriteRef;
  readonly verb: string;
  readonly filterSummary: string;
  readonly default?: boolean;
}

export interface DmDiet {
  readonly stat: 'protein' | 'sugar';
  readonly edibleWhen: {
    readonly op: '<' | '<=' | '>';
    readonly value: number;
  };
  readonly color: string;
  readonly hint: string;
  readonly filterName: string;
  readonly filterSummary: string;
}

export interface DmForkInfo {
  readonly sourceKind: 'dm';
  readonly name: string;
  readonly description: string;
  readonly hidden?: boolean;
  readonly path: string;
  readonly repo: string;
  readonly default?: boolean;
  readonly extractor: string;
  readonly methodSprites: {
    readonly mix: DmSpriteRef;
    readonly microwave: DmSpriteRef;
    readonly cut: DmSpriteRef;
  };
  readonly mixFillSprite: DmSpriteRef;
  readonly fallbackSprite: DmSpriteRef;
  readonly appliances: Readonly<Record<string, DmApplianceInfo>>;
  readonly defaultAttribution?: {
    readonly license: string;
    readonly copyright: string;
  };
  readonly maxAlternatives?: number;
  readonly ignoreSourcesOf?: readonly string[];
  readonly diets?: readonly DmDiet[];
}

interface Sprite {
  readonly rsi: string | null;
  readonly state: string | null;
  readonly color: string | null;
}

interface ParsedItem {
  readonly id: string;
  readonly name: string;
  readonly isFood: boolean;
  readonly sprite: Sprite;
  readonly slicePath: string | null;
  readonly slicesNum: number | null;
  readonly reagents: Readonly<Record<string, number>>;
}

interface ParsedReagent {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly proteinAmount: number | null;
  readonly sugarAmount: number | null;
}

interface ParsedProduce {
  readonly id: string;
  readonly growPath: string;
  readonly name: string;
  readonly kitchenTag: string | null;
  readonly sprite: { readonly base: Sprite; readonly leaf: Sprite | null };
  readonly productType: string | null;
  readonly chems: Readonly<Record<string, readonly [number, number]>>;
}

interface ParsedReaction {
  readonly id: string;
  readonly result: string | null;
  readonly resultAmount: number;
  readonly reagents: Readonly<Record<string, number>>;
  readonly catalysts: Readonly<Record<string, number>>;
  readonly minTemp: number | null;
  readonly maxTemp: number | null;
  readonly spawns: readonly string[];
  readonly conditional: boolean;
}

interface ParsedCookingRecipe {
  readonly id: string;
  readonly result: string;
  readonly resultQty: number;
  readonly reagents: Readonly<Record<string, number>>;
  readonly consumed: Readonly<Record<string, number>>;
  readonly items: Readonly<Record<string, number>>;
  readonly produce: Readonly<Record<string, number>>;
  readonly appliances: readonly string[];
  readonly reagentMix: number;
}

interface ParserOutput {
  readonly commit: string | null;
  readonly reactions: readonly ParsedReaction[];
  readonly cookingRecipes: readonly ParsedCookingRecipe[];
  readonly items: readonly ParsedItem[];
  readonly reagents: readonly ParsedReagent[];
  readonly produce: readonly ParsedProduce[];
}

const ItemPrefix = '/obj/item/';
const ReagentPrefix = '/datum/reagent/';
const DefaultGroup = 'Other';

const entityId = (path: string): EntityId =>
  path.slice(ItemPrefix.length) as EntityId;
const reagentId = (path: string): ReagentId =>
  path.slice(ReagentPrefix.length) as ReagentId;
const applianceEntityId = (name: string): EntityId =>
  `appliance!${name}` as EntityId;

type Amounts = Map<string, number>;

const addAmounts = (dst: Amounts, src: ReadonlyMap<string, number>, mult = 1) => {
  for (const [id, n] of src) {
    dst.set(id, (dst.get(id) ?? 0) + n * mult);
  }
};

const mixReagents = (
  mode: number,
  own: ReadonlyMap<string, number>,
  buffer: ReadonlyMap<string, number>
): Amounts => {
  const result: Amounts = new Map(own);
  switch (mode) {
    case 0:
      break;
    case 1:
      for (const [id, n] of buffer) {
        result.set(id, Math.max(own.get(id) ?? 0, n));
      }
      break;
    case 2:
      for (const [id, n] of buffer) {
        const have = own.get(id) ?? 0;
        result.set(id, have === 0 ? n : Math.min(have, n));
      }
      break;
    default:
      addAmounts(result, buffer);
  }
  return result;
};

const runParser = (fork: DmForkInfo): ParserOutput => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-parser-'));
  const out = join(dir, 'out.json');
  try {
    execFileSync(
      'cargo',
      [
        'run',
        '--release',
        '--quiet',
        '--manifest-path',
        resolve(fork.extractor, 'Cargo.toml'),
        '--',
        resolve(fork.path),
        out,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    );
    return JSON.parse(readFileSync(out, 'utf-8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

class RsiStates {
  private readonly cache = new Map<string, ReadonlySet<string> | null>();
  private readonly root: string;

  public constructor(root: string) {
    this.root = root;
  }

  public has(rsi: string | null, state: string | null): boolean {
    if (!rsi || !state) {
      return false;
    }
    let states = this.cache.get(rsi);
    if (states === undefined) {
      const meta = resolve(this.root, rsi, 'meta.json');
      states = existsSync(meta)
        ? new Set<string>(
          (JSON.parse(readFileSync(meta, 'utf-8')).states ?? [])
            .map((s: { name: string }) => s.name)
        )
        : null;
      this.cache.set(rsi, states);
    }
    return states?.has(state) ?? false;
  }
}

const emptyEntity = (
  id: EntityId,
  name: string,
  sprite: ResolvedEntity['sprite'],
  isProduce = false
): ResolvedEntity => ({
  id,
  name,
  abstract: false,
  isProduce,
  sprite,
  solutions: null,
  reagents: new Set(),
  extractable: null,
  foodSequenceStart: null,
  foodSequenceElement: null,
  sliceableFood: null,
  butcherable: null,
  toolRefinable: null,
  construction: null,
  deepFryOutput: null,
  stomach: null,
  tags: new Set(),
  components: new Set(),
});

const simpleSprite = (
  rsi: string,
  state: string,
  color: string | null = null
): ResolvedEntity['sprite'] => ({
  path: rsi,
  state,
  color,
  layers: [],
});

export const buildDmFork = async (
  id: string,
  fork: DmForkInfo
): Promise<ProcessedGameData> => {
  console.log(`Starting work on DM fork ${id}: ${fork.name}...`);
  const data = runParser(fork);
  const states = new RsiStates(resolve(fork.path));

  const itemById = new Map(data.items.map(i => [i.id, i]));
  const reagentById = new Map(data.reagents.map(r => [r.id, r]));

  const seedsByTag = new Map<string, ParsedProduce[]>();
  for (const seed of data.produce) {
    if (!seed.kitchenTag || seed.productType) {
      continue;
    }
    const group = seedsByTag.get(seed.kitchenTag) ?? [];
    group.push(seed);
    seedsByTag.set(seed.kitchenTag, group);
  }
  for (const group of seedsByTag.values()) {
    group.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
  }
  const seedByGrowPath = new Map(data.produce.map(p => [p.growPath, p]));

  const entities = new Map<EntityId, ResolvedEntity>();
  const fallback = simpleSprite(
    fork.fallbackSprite.rsi,
    fork.fallbackSprite.state
  );

  const addItem = (path: string): EntityId | null => {
    const id = entityId(path);
    if (entities.has(id)) {
      return id;
    }
    const seed = seedByGrowPath.get(path);
    if (seed) {
      addProduce(seed);
      return id;
    }
    const item = itemById.get(path);
    if (!item) {
      return null;
    }
    const { rsi, state, color } = item.sprite;
    entities.set(id, emptyEntity(
      id,
      item.name,
      states.has(rsi, state) ? simpleSprite(rsi!, state!, color) : fallback
    ));
    return id;
  };

  const addProduce = (seed: ParsedProduce): void => {
    const id = entityId(seed.growPath);
    if (entities.has(id)) {
      return;
    }
    const { base, leaf } = seed.sprite;
    const layers = [];
    if (states.has(base.rsi, base.state)) {
      layers.push({
        path: base.rsi,
        state: base.state,
        color: base.color,
        visible: true,
      });
    }
    if (leaf && states.has(leaf.rsi, leaf.state)) {
      layers.push({
        path: leaf.rsi,
        state: leaf.state,
        color: leaf.color,
        visible: true,
      });
    }
    entities.set(id, emptyEntity(
      id,
      seed.name,
      layers.length > 0
        ? { path: null, state: null, color: null, layers }
        : fallback,
      true
    ));
  };

  const maxAlts = fork.maxAlternatives ?? 0;
  const subtypesOf = (path: string): string[] => {
    const prefix = `${path}/`;
    const result = data.items
      .filter(i => i.id.startsWith(prefix))
      .map(i => i.id);
    return maxAlts > 0 ? result.slice(0, maxAlts) : result;
  };

  const lookKey = (id: EntityId): string => {
    const e = entities.get(id)!;
    return JSON.stringify([e.name, e.sprite]);
  };
  const distinctAlternatives = (
    main: EntityId,
    candidates: readonly EntityId[]
  ): EntityId[] => {
    const seen = new Set([lookKey(main)]);
    const result: EntityId[] = [];
    for (const id of candidates) {
      const key = lookKey(id);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(id);
      }
    }
    return result;
  };

  const recipes = new Map<string, ResolvedRecipe>();
  const usedReagents = new Set<string>();
  const knownReagent = (path: string): boolean => reagentById.has(path);

  const applianceNames = new Set(Object.keys(fork.appliances));

  for (const r of data.cookingRecipes) {
    const solidResult = addItem(r.result);
    if (!solidResult) {
      console.warn(`Recipe '${r.id}': unknown result ${r.result}`);
      continue;
    }

    const solids: Record<EntityId, number> = {};
    const alts: Record<EntityId, readonly EntityId[]> = {};
    let ok = true;

    for (const [path, qty] of Object.entries(r.items)) {
      const main = addItem(path);
      if (!main) {
        console.warn(`Recipe '${r.id}': unknown item ${path}`);
        ok = false;
        continue;
      }
      solids[main] = (solids[main] ?? 0) + qty;
      const subtypes = distinctAlternatives(
        main,
        subtypesOf(path)
          .map(addItem)
          .filter((x): x is EntityId => x !== null)
      );
      if (subtypes.length > 0) {
        alts[main] = subtypes;
      }
    }

    for (const [tag, qty] of Object.entries(r.produce)) {
      const group = seedsByTag.get(tag);
      if (!group) {
        console.warn(`Recipe '${r.id}': unknown produce tag ${tag}`);
        ok = false;
        continue;
      }
      const main = addItem(group[0].growPath)!;
      solids[main] = (solids[main] ?? 0) + qty;
      const subtypes = distinctAlternatives(
        main,
        group.slice(1).map(s => addItem(s.growPath)!)
      );
      if (subtypes.length > 0) {
        alts[main] = subtypes;
      }
    }

    const reagents: Record<ReagentId, { amount: number }> = {};
    for (const [path, amount] of [
      ...Object.entries(r.reagents),
      ...Object.entries(r.consumed),
    ]) {
      if (!knownReagent(path)) {
        console.warn(`Recipe '${r.id}': unknown reagent ${path}`);
        ok = false;
        continue;
      }
      const rid = reagentId(path);
      reagents[rid] = { amount: (reagents[rid]?.amount ?? 0) + amount };
      usedReagents.add(path);
    }

    if (!ok) {
      continue;
    }

    const subtypes = r.appliances.filter(a => applianceNames.has(a));
    const recipe: ResolvedMicrowaveRecipe = {
      method: 'microwave',
      time: 0,
      solidResult,
      reagentResult: null,
      resultQty: r.resultQty > 1 ? r.resultQty : undefined,
      solids,
      alts: Object.keys(alts).length > 0 ? alts : undefined,
      reagents,
      subtype: subtypes.length === 1 ? subtypes[0] : subtypes,
      group: DefaultGroup,
    };
    recipes.set(r.id, recipe);
  }

  for (const reaction of data.reactions) {
    if (
      reaction.result ||
      reaction.conditional ||
      reaction.resultAmount <= 0 ||
      reaction.spawns.length !== 1 ||
      !itemById.get(reaction.spawns[0])?.isFood
    ) {
      continue;
    }
    const inputs = [
      ...Object.keys(reaction.reagents),
      ...Object.keys(reaction.catalysts),
    ];
    if (!inputs.every(knownReagent)) {
      console.warn(`Reaction '${reaction.id}': unknown reagent, skipping`);
      continue;
    }
    const solidResult = addItem(reaction.spawns[0])!;

    const reagents: Record<ReagentId, { amount: number; catalyst?: boolean }> = {};
    for (const [rp, amount] of Object.entries(reaction.reagents)) {
      reagents[reagentId(rp)] = { amount };
    }
    for (const [rp, amount] of Object.entries(reaction.catalysts)) {
      reagents[reagentId(rp)] = { amount, catalyst: true };
    }
    const recipe: ResolvedReactionRecipe = {
      method: 'mix',
      solidResult,
      reagentResult: null,
      resultQty: reaction.resultAmount,
      minTemp: reaction.minTemp ?? 0,
      maxTemp: reaction.maxTemp,
      solids: {},
      reagents,
      group: DefaultGroup,
    };
    recipes.set(`r!${reaction.id}`, recipe);
    inputs.forEach(input => usedReagents.add(input));
  }

  const reactionsByResult = new Map<string, ParsedReaction[]>();
  for (const reaction of data.reactions) {
    if (!reaction.result || reaction.resultAmount <= 0) {
      continue;
    }
    const list = reactionsByResult.get(reaction.result) ?? [];
    list.push(reaction);
    reactionsByResult.set(reaction.result, list);
  }

  const queue = [...usedReagents];
  const seenReactions = new Set<string>();
  while (queue.length > 0) {
    const path = queue.pop()!;
    for (const reaction of reactionsByResult.get(path) ?? []) {
      if (seenReactions.has(reaction.id)) {
        continue;
      }
      const inputs = [
        ...Object.keys(reaction.reagents),
        ...Object.keys(reaction.catalysts),
      ];
      if (!knownReagent(reaction.result!) || !inputs.every(knownReagent)) {
        console.warn(`Reaction '${reaction.id}': unknown reagent, skipping`);
        seenReactions.add(reaction.id);
        continue;
      }
      seenReactions.add(reaction.id);

      const reagents: Record<ReagentId, { amount: number; catalyst?: boolean }> = {};
      for (const [rp, amount] of Object.entries(reaction.reagents)) {
        reagents[reagentId(rp)] = { amount };
      }
      for (const [rp, amount] of Object.entries(reaction.catalysts)) {
        reagents[reagentId(rp)] = { amount, catalyst: true };
      }

      const recipe: ResolvedReactionRecipe = {
        method: 'mix',
        solidResult: null,
        reagentResult: reagentId(reaction.result!),
        resultQty: reaction.resultAmount,
        minTemp: reaction.minTemp ?? 0,
        maxTemp: reaction.maxTemp,
        solids: {},
        reagents,
        group: DefaultGroup,
      };
      recipes.set(`r!${reaction.id}`, recipe);

      usedReagents.add(reaction.result!);
      for (const input of inputs) {
        if (!usedReagents.has(input)) {
          usedReagents.add(input);
          queue.push(input);
        }
      }
    }
  }

  const diets = buildDietSpecials(fork, data, seedsByTag, seedByGrowPath, itemById);

  const referencedSolids = (): Set<EntityId> => {
    const result = new Set<EntityId>();
    for (const recipe of recipes.values()) {
      for (const id of Object.keys(recipe.solids) as EntityId[]) {
        result.add(id);
      }
      for (const alts of Object.values(recipe.alts ?? {})) {
        alts.forEach(id => result.add(id));
      }
    }
    return result;
  };

  for (let added = true; added;) {
    added = false;
    const used = referencedSolids();
    for (const item of data.items) {
      if (!item.slicePath || !item.slicesNum || item.slicesNum < 1) {
        continue;
      }
      const recipeId = `cut!${entityId(item.id)}`;
      const sliceId = entityId(item.slicePath);
      if (recipes.has(recipeId) || !used.has(sliceId)) {
        continue;
      }
      const whole = addItem(item.id);
      if (!whole) {
        continue;
      }
      recipes.set(
        recipeId,
        new ConstructRecipeBuilder()
          .withSolidResult(sliceId)
          .withResultQty(item.slicesNum)
          .startWith(whole)
          .cut()
          .toRecipe()
      );
      added = true;
    }
  }

  const ignoredSources = new Set(fork.ignoreSourcesOf ?? []);
  const reagentSources = new Map<ReagentId, EntityId[]>();
  for (const seed of data.produce) {
    if (seed.productType) {
      continue;
    }
    for (const path of Object.keys(seed.chems)) {
      if (!usedReagents.has(path) || ignoredSources.has(path)) {
        continue;
      }
      const source = addItem(seed.growPath)!;
      const rid = reagentId(path);
      const sources = reagentSources.get(rid) ?? [];
      if (!sources.includes(source)) {
        sources.push(source);
      }
      reagentSources.set(rid, sources);
    }
  }

  const referenced = referencedSolids();
  for (const recipe of recipes.values()) {
    if (recipe.solidResult) {
      referenced.add(recipe.solidResult);
    }
  }
  for (const sources of reagentSources.values()) {
    sources.forEach(id => referenced.add(id));
  }
  for (const id of entities.keys()) {
    if (!referenced.has(id)) {
      entities.delete(id);
    }
  }

  const reagents = new Map<ReagentId, ResolvedReagent>();
  for (const path of usedReagents) {
    const reagent = reagentById.get(path)!;
    reagents.set(reagentId(path), {
      name: reagent.name,
      color: reagent.color ?? '#ffffff',
    });
  }

  const methodEntities = new Map<'mix' | 'microwave' | 'cut', ResolvedEntity>([
    ['mix', emptyEntity(
      'method!mix' as EntityId,
      'Mix',
      simpleSprite(fork.methodSprites.mix.rsi, fork.methodSprites.mix.state)
    )],
    ['microwave', emptyEntity(
      'method!microwave' as EntityId,
      'Cook',
      simpleSprite(
        fork.methodSprites.microwave.rsi,
        fork.methodSprites.microwave.state
      )
    )],
    ['cut', emptyEntity(
      'method!cut' as EntityId,
      'Cut',
      simpleSprite(fork.methodSprites.cut.rsi, fork.methodSprites.cut.state)
    )],
  ]);

  const recipeTypes: Record<string, {
    default?: boolean;
    machine: EntityId;
    verb: string;
    filterSummary: string;
  }> = {};
  const recipeTypeEntities = new Map<string, ResolvedEntity>();
  for (const [name, info] of Object.entries(fork.appliances)) {
    const machine = applianceEntityId(name);
    recipeTypes[name] = {
      default: info.default,
      machine,
      verb: info.verb,
      filterSummary: info.filterSummary,
    };
    recipeTypeEntities.set(name, emptyEntity(
      machine,
      info.verb,
      simpleSprite(info.sprite.rsi, info.sprite.state)
    ));
  }

  const resolved: ResolvedGameData = {
    entities,
    reagents,
    recipes,
    reagentSources,
    methodEntities,
    microwaveRecipeTypeEntities: recipeTypeEntities,
  };
  console.log(
    `Resolved ${entities.size} entities, ${reagents.size} reagents and ${
      recipes.size
    } recipes`
  );

  const spriteSheet = await buildSpriteSheet(
    resolved,
    resolve(fork.path),
    fork.mixFillSprite.state,
    new Map<string, SpritePoint>(),
    fork.mixFillSprite.rsi
  );
  console.log(`Built sprite sheet for ${spriteSheet.spriteCount} sprites`);

  const attributions = spriteSheet.attributions
    .map(applyDefaultAttribution(fork))
    .map(attr => ({ ...attr, path: attr.path.replace(/\.rsi$/, '.dmi') }));

  return {
    id,
    name: fork.name,
    description: fork.description,
    default: fork.default ?? false,
    hidden: fork.hidden,
    resolved,
    foodSequenceStartPoints: new Map(),
    foodSequenceElements: new Map(),
    foodSequenceEndPoints: new Map(),
    specials: diets,
    sprites: { ...spriteSheet, attributions },
    microwaveRecipeTypes: recipeTypes as MicrowaveRecipeTypes,
    sortingIdRewrites: {},
    commitHash: data.commit ?? 'unknown',
    repo: fork.repo,
    texturesPath: '',
  };
};

const applyDefaultAttribution = (fork: DmForkInfo) =>
  (attr: SpriteAttribution): SpriteAttribution => {
    const def = fork.defaultAttribution;
    if (!def || attr.license || attr.copyright) {
      return attr;
    }
    return { ...attr, license: def.license, copyright: def.copyright };
  };

const buildDietSpecials = (
  fork: DmForkInfo,
  data: ParserOutput,
  seedsByTag: ReadonlyMap<string, readonly ParsedProduce[]>,
  seedByGrowPath: ReadonlyMap<string, ParsedProduce>,
  itemById: ReadonlyMap<string, ParsedItem>
): Special[] => {
  const diets = fork.diets ?? [];
  if (diets.length === 0) {
    return [];
  }

  const coefficients = {
    protein: new Map<string, number>(),
    sugar: new Map<string, number>(),
  };
  for (const r of data.reagents) {
    coefficients.protein.set(r.id, r.proteinAmount ?? 0);
    coefficients.sugar.set(r.id, r.sugarAmount ?? 0);
  }

  const recipesByResult = new Map<string, ParsedCookingRecipe[]>();
  for (const r of data.cookingRecipes) {
    const list = recipesByResult.get(r.result) ?? [];
    list.push(r);
    recipesByResult.set(r.result, list);
  }

  const own = (path: string): Amounts => {
    const result: Amounts = new Map();
    const item = itemById.get(path);
    if (item) {
      addAmounts(result, new Map(Object.entries(item.reagents)));
    }
    const seed = seedByGrowPath.get(path);
    if (seed) {
      for (const [id, [min, max]] of Object.entries(seed.chems)) {
        result.set(id, (result.get(id) ?? 0) + (min + max) / 2);
      }
    }
    return result;
  };

  const memo = new Map<string, Amounts>();
  const visiting = new Set<string>();
  const effective = (path: string): Amounts => {
    const cached = memo.get(path);
    if (cached) {
      return cached;
    }
    const base = own(path);
    if (visiting.has(path)) {
      return base;
    }
    visiting.add(path);

    const recipes = recipesByResult.get(path) ?? [];
    let result: Amounts = base;
    if (recipes.length > 0) {
      result = new Map();
      for (const r of recipes) {
        const buffer: Amounts = new Map();
        for (const [item, qty] of Object.entries(r.items)) {
          addAmounts(buffer, effective(item), qty);
        }
        for (const [tag, qty] of Object.entries(r.produce)) {
          const seed = seedsByTag.get(tag)?.[0];
          if (seed) {
            addAmounts(buffer, own(seed.growPath), qty);
          }
        }
        addAmounts(buffer, new Map(Object.entries(r.reagents)));

        const perResult: Amounts = new Map();
        addAmounts(perResult, buffer, 1 / Math.max(1, r.resultQty));
        for (const [id, n] of mixReagents(r.reagentMix, base, perResult)) {
          result.set(id, Math.max(result.get(id) ?? 0, n));
        }
      }
    }

    visiting.delete(path);
    memo.set(path, result);
    return result;
  };

  const isFood = (path: string): boolean =>
    seedByGrowPath.has(path) || (itemById.get(path)?.isFood ?? false);

  return diets.map((diet, i): Special => {
    const coeff = coefficients[diet.stat];
    const { op, value } = diet.edibleWhen;
    return {
      mask: 1 << i,
      hint: diet.hint,
      color: diet.color,
      filterName: diet.filterName,
      filterSummary: diet.filterSummary,
      entityMatches: ent => {
        const path = `${ItemPrefix}${ent.id}`;
        if (!isFood(path)) {
          return false;
        }
        let total = 0;
        for (const [id, n] of effective(path)) {
          total += n * (coeff.get(id) ?? 0);
        }
        switch (op) {
          case '<':
            return total < value;
          case '<=':
            return total <= value;
          case '>':
            return total > value;
        }
      },
    };
  });
};
