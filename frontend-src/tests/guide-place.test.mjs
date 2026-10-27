import assert from 'node:assert/strict';
import {placeGuide} from '../src/guide-place.ts';
const overlaps=(spot,card,target)=>spot.left<target.right&&spot.left+card.width>target.left&&spot.top<target.bottom&&spot.top+card.height>target.top;
const card={width:320,height:290};
// Desktop composer dock (1440×900): the card goes above the input, aligned to its left edge.
const composer={left:512,top:636,right:1232,bottom:884};
let spot=placeGuide(card,composer,{width:1440,height:900});
assert.deepEqual(spot,{top:334,left:512});assert.equal(overlaps(spot,card,composer),false);
// Tall conversation dock: no room above, so the card moves beside the dock.
const conversation={left:512,top:308,right:1232,bottom:884};
spot=placeGuide(card,conversation,{width:1440,height:900});
assert.equal(spot.left,180);assert.equal(overlaps(spot,card,conversation),false);
// Phone conversation dock spans the width: nothing fits, the caller switches to the compact card.
const phone={left:12,top:232,right:363,bottom:800};
assert.equal(placeGuide({width:351,height:250},phone,{width:375,height:812},12),null);
spot=placeGuide({width:351,height:130},phone,{width:375,height:812},12);
assert.deepEqual(spot,{top:90,left:12});assert.equal(overlaps(spot,{width:351,height:130},phone),false);
// Short phone (375×667) with the tall conversation dock: even the measured compact card (≈190px)
// has no clear spot, so Help.tsx falls back to sitting directly above the dock with its own scroll.
assert.equal(placeGuide({width:351,height:190},{left:12,top:188,right:363,bottom:655},{width:375,height:667},12),null);
console.log('Walkthrough placement passed.');
