'use strict';
// SC-01 walkable path, authored against the 960×540 background image. Coordinates
// are screen-image pixels; the authoritative world occupies 1600×600.
const PLAZA = Object.freeze([[0,420],[275,310],[690,220],[770,180],[860,180],[860,275],[775,350],[680,385],[670,540],[255,540],[90,470]]);
// Foreground lantern base blocks feet; trunk/lamps above it are not ground collision.
const OBSTACLES = Object.freeze([{ minX: 600, minY: 475, maxX: 645, maxY: 510 }]);
const SPAWNS = Object.freeze([{x:120,y:470},{x:350,y:500},{x:650,y:500}]);
function inside(px,py){
  let hit=false;
  for(let i=0,j=PLAZA.length-1;i<PLAZA.length;j=i++) {
    const [xi,yi]=PLAZA[i], [xj,yj]=PLAZA[j];
    if((yi>py)!==(yj>py) && px<(xj-xi)*(py-yi)/(yj-yi)+xi)hit=!hit;
  }
  return hit;
}
function isWalkable(x,y){
  if (!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1600||y<0||y>600) return false;
  const sx=x*0.6, sy=y*0.9;
  return inside(sx,sy) && !OBSTACLES.some(o=>sx>=o.minX&&sx<=o.maxX&&sy>=o.minY&&sy<=o.maxY);
}
// Deterministic nearest grid point; used only for migration of pre-existing loot.
function nearestWalkable(x,y){
  if(isWalkable(x,y)) return {x,y};
  if(!Number.isFinite(x)||!Number.isFinite(y)) return {...SPAWNS[1]};
  let best=null, bestDistance=Infinity;
  for(let py=0;py<=600;py+=8)for(let px=0;px<=1600;px+=8){
    const d=(px-x)**2+(py-y)**2;
    if(d<bestDistance&&isWalkable(px,py)){best={x:px,y:py};bestDistance=d;}
  }
  return best||{...SPAWNS[1]};
}
function canTraverse(x,y,nx,ny){
  if(!isWalkable(x,y))return false;
  const length=Math.hypot(nx-x,ny-y),steps=Math.max(1,Math.ceil(length/3));
  for(let i=1;i<=steps;i++){const t=i/steps;if(!isWalkable(x+(nx-x)*t,y+(ny-y)*t))return false;}
  return true;
}
module.exports={PLAZA,OBSTACLES,SPAWNS,isWalkable,canTraverse,nearestWalkable};
