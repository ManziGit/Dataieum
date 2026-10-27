export type Box={left:number;top:number;right:number;bottom:number};
export type Size={width:number;height:number};

// Place the walkthrough card next to the element it describes without covering it:
// above first (where the eye already is), then beside it. Null means no clear spot.
export function placeGuide(card:Size,target:Box,viewport:Size,margin=16,gap=12):{top:number;left:number}|null {
  const clampLeft=(left:number)=>Math.min(Math.max(left,margin),viewport.width-card.width-margin);
  const clampTop=(top:number)=>Math.min(Math.max(top,margin),viewport.height-card.height-margin);
  const candidates=[
    {top:target.top-gap-card.height,left:clampLeft(target.left)},
    {top:clampTop(target.bottom-card.height),left:target.left-gap-card.width},
    {top:clampTop(target.bottom-card.height),left:target.right+gap},
  ];
  // Each candidate already clears the target by construction; only the viewport can rule one out.
  return candidates.find(spot=>spot.top>=margin&&spot.left>=margin&&spot.left+card.width<=viewport.width-margin&&spot.top+card.height<=viewport.height-margin)||null;
}
