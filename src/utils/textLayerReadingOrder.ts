interface TextUnit {
  element: HTMLSpanElement;
  nodes: HTMLElement[];
  index: number;
  rectangle: DOMRect;
}

interface TwoColumnLayout {
  left: TextUnit[];
  right: TextUnit[];
  remaining: TextUnit[];
}

const MINIMUM_COLUMN_SPANS = 8;

export function correctTextLayerReadingOrder(textLayer: HTMLElement): boolean {
  if (textLayer.dataset.readingOrderCorrected === 'true') {
    return false;
  }

  const units = createTextUnits(textLayer);
  if (!units) {
    return false;
  }

  const layout = detectTwoColumnLayout(units, textLayer.getBoundingClientRect());
  if (!layout) {
    return false;
  }

  const firstColumnTop = Math.min(
    ...layout.left.map((unit) => unit.rectangle.top),
    ...layout.right.map((unit) => unit.rectangle.top),
  );

  const beforeColumns = layout.remaining.filter(
    (unit) => unit.rectangle.bottom <= firstColumnTop,
  );
  const afterColumns = layout.remaining.filter(
    (unit) => unit.rectangle.bottom > firstColumnTop,
  );

  const orderedUnits = [
    ...sortInReadingOrder(beforeColumns),
    ...sortInReadingOrder(layout.left),
    ...sortInReadingOrder(layout.right),
    ...sortInReadingOrder(afterColumns),
  ];

  textLayer.replaceChildren(
    ...orderedUnits.flatMap((unit) => unit.nodes),
  );
  textLayer.dataset.readingOrderCorrected = 'true';

  return true;
}

function createTextUnits(textLayer: HTMLElement): TextUnit[] | null {
  const children = Array.from(textLayer.children);
  const units: TextUnit[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const element = children[index];

    if (!(element instanceof HTMLSpanElement)) {
      return null;
    }

    const nodes: HTMLElement[] = [element];
    const nextElement = children[index + 1];

    if (nextElement instanceof HTMLBRElement) {
      nodes.push(nextElement);
      index += 1;
    }

    units.push({
      element,
      nodes,
      index: units.length,
      rectangle: element.getBoundingClientRect(),
    });
  }

  return units;
}

function detectTwoColumnLayout(
  units: TextUnit[],
  layerRectangle: DOMRect,
): TwoColumnLayout | null {
  if (layerRectangle.width === 0 || units.length < MINIMUM_COLUMN_SPANS * 2) {
    return null;
  }

  const bodyUnits = units.filter((unit) => isBodyText(unit, layerRectangle));
  if (bodyUnits.length < MINIMUM_COLUMN_SPANS * 2) {
    return null;
  }

  const gutter = layerRectangle.width * 0.025;
  const candidates = Array.from({ length: 17 }, (_, index) =>
    layerRectangle.left + layerRectangle.width * (0.34 + index * 0.02),
  );

  const splitCandidates = candidates.flatMap((candidate) => {
    const split = classifyAtSplit(bodyUnits, candidate, gutter);
    return split ? [split] : [];
  });
  const split = splitCandidates.sort(
    (first, second) => second.score - first.score,
  )[0];

  if (!split || !columnsShareVerticalBody(split.left, split.right, layerRectangle)) {
    return null;
  }

  const bodyUnitSet = new Set(bodyUnits);

  return {
    left: split.left,
    right: split.right,
    remaining: units.filter(
      (unit) =>
        !bodyUnitSet.has(unit) ||
        (!split.left.includes(unit) && !split.right.includes(unit)),
    ),
  };
}

function isBodyText(unit: TextUnit, layerRectangle: DOMRect): boolean {
  const { rectangle } = unit;
  const text = unit.element.textContent?.trim() ?? '';

  return (
    text.length > 0 &&
    rectangle.width > 0 &&
    rectangle.height > 0 &&
    rectangle.width < layerRectangle.width * 0.62
  );
}

function classifyAtSplit(
  units: TextUnit[],
  split: number,
  gutter: number,
): { left: TextUnit[]; right: TextUnit[]; score: number } | null {
  const left = units.filter((unit) => unit.rectangle.right <= split - gutter);
  const right = units.filter((unit) => unit.rectangle.left >= split + gutter);
  const crossing = units.length - left.length - right.length;

  if (
    left.length < MINIMUM_COLUMN_SPANS ||
    right.length < MINIMUM_COLUMN_SPANS ||
    crossing > units.length * 0.16
  ) {
    return null;
  }

  return {
    left,
    right,
    score: left.length + right.length - crossing * 3,
  };
}

function columnsShareVerticalBody(
  left: TextUnit[],
  right: TextUnit[],
  layerRectangle: DOMRect,
): boolean {
  const leftTop = Math.min(...left.map((unit) => unit.rectangle.top));
  const leftBottom = Math.max(...left.map((unit) => unit.rectangle.bottom));
  const rightTop = Math.min(...right.map((unit) => unit.rectangle.top));
  const rightBottom = Math.max(...right.map((unit) => unit.rectangle.bottom));
  const overlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop);

  return overlap >= layerRectangle.height * 0.2;
}

function sortInReadingOrder(units: TextUnit[]): TextUnit[] {
  const lineTolerance = Math.max(
    2,
    Math.min(...units.map((unit) => unit.rectangle.height)) * 0.5,
  );

  return [...units].sort((first, second) => {
    const verticalDifference = first.rectangle.top - second.rectangle.top;

    if (Math.abs(verticalDifference) > lineTolerance) {
      return verticalDifference;
    }

    const horizontalDifference = first.rectangle.left - second.rectangle.left;
    return horizontalDifference || first.index - second.index;
  });
}
