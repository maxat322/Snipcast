/** Decimal coefficients avoid IEEE-754 rounding and preserve arbitrarily large OCR numbers. */
export function sumNumbers(text:string):{sum:string;count:number}|null {
  const values:{value:bigint;scale:number}[]=[];
  const normalized=text.replace(/[−–]/g,"-");
  // Grouping spaces must separate complete groups of three, not arbitrary numbers.
  const tokens=normalized.match(/[+-]?\d+(?:[ \u00a0\u202f]\d{3}(?!\d))*(?:[.,]\d+)*/g)??[];
  for(const token of tokens){
    const clean=token.replace(/[ \u00a0\u202f]/g,"");
    if((clean.match(/[.,]/g)??[]).length>1)continue;
    const [whole,fraction=""]=clean.replace(",",".").split(".");
    values.push({value:BigInt(whole!+fraction),scale:fraction.length});
  }
  if(!values.length)return null;
  const scale=Math.max(...values.map(v=>v.scale));
  const total=values.reduce((sum,v)=>sum+v.value*10n**BigInt(scale-v.scale),0n);
  const sign=total<0n?"-":"";
  let digits=(total<0n?-total:total).toString().padStart(scale+1,"0");
  if(scale)digits=(digits.slice(0,-scale)+","+digits.slice(-scale)).replace(/0+$/,"").replace(/,$/,"");
  return {sum:sign+digits,count:values.length};
}
