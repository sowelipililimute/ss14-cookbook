import { ReactElement, memo } from 'react';
import { Reagent, ReagentIngredient as ReagentIngredientData } from '../../types';
import { useGameData } from '../context';
import { Popup, usePopupTrigger } from '../popup';
import { EntitySprite, ReagentSprite } from '../sprites';
import { Tooltip } from '../tooltip';
import { ReagentInfoPopup, RecipePopup } from './popup';

export interface RecipeIngredientsProps {
  visible: boolean;
  solids: Readonly<Record<string, number>>;
  alts?: Readonly<Record<string, readonly string[]>>;
  reagents: Readonly<Record<string, ReagentIngredientData>>;
}

const IngredientSpriteHeight = 32;

export const RecipeIngredients = memo(({
  visible,
  solids,
  alts,
  reagents,
}: RecipeIngredientsProps): ReactElement => {
  if (!visible) {
    const ingredientCount =
      Object.keys(solids).length +
      Object.keys(reagents).length;
    return (
      <div
        className='recipe_ingredients'
        style={{
          height: `${ingredientCount * IngredientSpriteHeight}px`,
        }}
      />
    );
  }

  return (
    <div className='recipe_ingredients'>
      {Object.entries(solids).map(([entId, qty]) =>
        <SolidIngredient key={entId} id={entId} qty={qty} alts={alts?.[entId]}/>
      )}
      {Object.entries(reagents).map(([reagentId, ingredient]) =>
        <ReagentIngredient
          key={reagentId}
          id={reagentId}
          amount={ingredient.amount}
          catalyst={ingredient.catalyst}
        />
      )}
    </div>
  );
});

export interface SolidIngredientProps {
  id: string;
  qty?: number;
  /** Other entities that can be used instead of this one. */
  alts?: readonly string[];
}

/** Maximum number of alternatives named in the tooltip. */
const MaxListedAlts = 8;

export const SolidIngredient = ({
  id,
  qty,
  alts,
}: SolidIngredientProps): ReactElement => {
  const { entityMap, recipesBySolidResult } = useGameData();
  const entity = entityMap.get(id)!;
  const relatedRecipes = recipesBySolidResult.get(id);

  return (
    <span className='recipe_ingredient'>
      <EntitySprite id={id}/>
      <span>
        {qty != null ? `${qty} ` : null}
        {relatedRecipes ? (
          <RecipePopup id={relatedRecipes}>
            <span className='more-info'>
              {entity.name}
            </span>
          </RecipePopup>
        ) : entity.name}
        {alts && alts.length > 0 && (
          <AlternativesNote alts={alts}/>
        )}
      </span>
    </span>
  );
};

const AlternativesNote = ({
  alts,
}: {
  alts: readonly string[];
}): ReactElement => {
  const { entityMap } = useGameData();
  const names = alts
    .slice(0, MaxListedAlts)
    .map(alt => entityMap.get(alt)?.name ?? alt);
  const more = alts.length - names.length;
  const text = `Or any of: ${names.join(', ')}${
    more > 0 ? `, and ${more} more` : ''
  }`;
  return <>
    {' '}
    <Tooltip text={text}>
      <span className='recipe_alternatives'>
        or {alts.length} other{alts.length === 1 ? '' : 's'}
      </span>
    </Tooltip>
  </>;
};

export interface ReagentIngredientProps {
  id: string;
  /** Single amount (in units), or [min, max]. */
  amount: number | readonly [min: number, max: number];
  catalyst?: boolean;
}

export const ReagentIngredient = ({
  id,
  amount,
  catalyst = false,
}: ReagentIngredientProps): ReactElement => {
  const { reagentMap, recipesByReagentResult } = useGameData();
  const reagent = reagentMap.get(id)!;
  const relatedRecipes = recipesByReagentResult.get(id);

  const formattedAmount = typeof amount === 'number'
    ? `${amount}u `
    : `${amount[0]}–${amount[1]}u `;

  return (
    <span className='recipe_ingredient'>
      <ReagentSprite id={id}/>
      <span>
        {formattedAmount}
        {relatedRecipes || reagent.sources.length > 0 ? (
          <ReagentInfoPopup
            recipes={relatedRecipes}
            sources={reagent.sources}
          >
            <span className='more-info'>
              {reagent.name}
            </span>
          </ReagentInfoPopup>
        ) : reagent.name}
        {catalyst && <>
          {' '}
          <Tooltip
            text={
              `You won’t lose any of the ${
                reagent.name
              } when making this recipe.`
            }
          >
            <span className='recipe_catalyst'>
              catalyst
            </span>
          </Tooltip>
        </>}
      </span>
    </span>
  );
};
