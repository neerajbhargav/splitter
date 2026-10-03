import type {BudgetMonth,Subscription,SubscriptionCycle,SubscriptionStatus} from './finance-types.ts';
import {FINANCE_MAX_CENTS} from './finance-types.ts';

type CalendarDate={year:number;month:number;day:number};
export type SubscriptionEquivalent={monthly_cents:bigint;yearly_cents:bigint};
export type SubscriptionForecastCharge={subscription_id:string;name:string;date:string;amount_cents:number};

const CYCLES:readonly SubscriptionCycle[]=['weekly','monthly','quarterly','yearly'];
const STATUSES:readonly SubscriptionStatus[]=['active','paused','canceled'];

function leap(year:number):boolean{return year%4===0&&(year%100!==0||year%400===0);}
function monthDays(year:number,month:number):number{return month===2?(leap(year)?29:28):([4,6,9,11].includes(month)?30:31);}
function parseDate(value:string):CalendarDate|null{
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
 if(!match)return null;
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
 if(year<1||year>9999||month<1||month>12||day<1||day>monthDays(year,month))return null;
 return {year,month,day};
}
function formatDate(date:CalendarDate):string|null{
 if(date.year<1||date.year>9999||date.month<1||date.month>12||date.day<1||date.day>monthDays(date.year,date.month))return null;
 return `${String(date.year).padStart(4,'0')}-${String(date.month).padStart(2,'0')}-${String(date.day).padStart(2,'0')}`;
}

/** Validates a calendar date without constructing a Date, so local/UTC offsets cannot change its day. */
export function isValidCalendarDate(value:string):boolean{return parseDate(value)!==null;}
function monthKey(value:string):string|null{
 const match=/^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value);
 if(!match)return null;
 const year=Number(match[1]),month=Number(match[2]);
 return year>=1&&year<=9999&&month>=1&&month<=12?`${match[1]}-${match[2]}`:null;
}
/** Finds the stored YYYY-MM-01 budget for a charge's YYYY-MM-DD calendar month. */
export function budgetForChargeDate<T extends Pick<BudgetMonth,'month'>>(budgets:readonly T[],date:string):T|undefined{
 if(!parseDate(date))return undefined;
 const target=monthKey(date);
 return target?budgets.find(budget=>monthKey(budget.month)===target):undefined;
}
export function compareCalendarDates(a:string,b:string):number{
 if(!isValidCalendarDate(a)||!isValidCalendarDate(b))throw new Error('Invalid calendar date');
 return a<b?-1:a>b?1:0;
}

// Howard Hinnant's civil-date algorithms, expressed as integer calendar arithmetic.
function dayNumber(date:CalendarDate):number{
 let y=date.year-(date.month<=2?1:0);
 const era=Math.floor(y/400);
 const yoe=y-era*400;
 const mp=date.month+(date.month>2?-3:9);
 const doy=Math.floor((153*mp+2)/5)+date.day-1;
 const doe=yoe*365+Math.floor(yoe/4)-Math.floor(yoe/100)+doy;
 return era*146097+doe;
}
function fromDayNumber(value:number):CalendarDate{
 const era=Math.floor(value/146097);
 const doe=value-era*146097;
 const yoe=Math.floor((doe-Math.floor(doe/1460)+Math.floor(doe/36524)-Math.floor(doe/146096))/365);
 let year=yoe+era*400;
 const doy=doe-(365*yoe+Math.floor(yoe/4)-Math.floor(yoe/100));
 const mp=Math.floor((5*doy+2)/153);
 const day=doy-Math.floor((153*mp+2)/5)+1;
 const month=mp+(mp<10?3:-9);
 year+=month<=2?1:0;
 return {year,month,day};
}

export function addCalendarDays(value:string,days:number):string|null{
 const date=parseDate(value);
 if(!date||!Number.isSafeInteger(days))return null;
 return formatDate(fromDayNumber(dayNumber(date)+days));
}
function addMonthsFromAnchor(anchor:CalendarDate,months:number):string|null{
 if(!Number.isSafeInteger(months)||months<0)return null;
 const zeroMonth=anchor.year*12+(anchor.month-1)+months;
 const year=Math.floor(zeroMonth/12),month=zeroMonth-year*12+1;
 return formatDate({year,month,day:Math.min(anchor.day,monthDays(year,month))});
}
function occurrence(anchor:CalendarDate,anchorIso:string,cycle:SubscriptionCycle,index:number):string|null{
 if(index<0||!Number.isSafeInteger(index))return null;
 if(cycle==='weekly')return addCalendarDays(anchorIso,index*7);
 if(cycle==='monthly')return addMonthsFromAnchor(anchor,index);
 if(cycle==='quarterly')return addMonthsFromAnchor(anchor,index*3);
 return addMonthsFromAnchor(anchor,index*12);
}

/** First scheduled renewal on or after `onOrAfter`, preserving the original anchor day/month. */
export function nextRenewalDate(anchorIso:string,cycle:SubscriptionCycle,onOrAfter:string):string|null{
 const anchor=parseDate(anchorIso),target=parseDate(onOrAfter);
 if(!anchor||!target||!CYCLES.includes(cycle))return null;
 if(anchorIso>=onOrAfter)return anchorIso;
 let index:number;
 if(cycle==='weekly'){
  const elapsed=dayNumber(target)-dayNumber(anchor);
  index=Math.ceil(elapsed/7);
 }else{
  const elapsedMonths=(target.year-anchor.year)*12+(target.month-anchor.month);
  const step=cycle==='monthly'?1:cycle==='quarterly'?3:12;
  index=Math.max(0,Math.floor(elapsedMonths/step));
 }
 let candidate=occurrence(anchor,anchorIso,cycle,index);
 if(candidate!==null&&candidate<onOrAfter)candidate=occurrence(anchor,anchorIso,cycle,index+1);
 return candidate;
}

/** Scheduled renewal dates in an inclusive calendar window. */
export function renewalDatesInWindow(anchorIso:string,cycle:SubscriptionCycle,start:string,end:string):string[]{
 if(!isValidCalendarDate(start)||!isValidCalendarDate(end)||start>end)return [];
 const first=nextRenewalDate(anchorIso,cycle,start);
 if(!first||first>end)return [];
 const anchor=parseDate(anchorIso);
 if(!anchor)return [];
 const dates:string[]=[];
 let current=first;
 // Windows used by this feature are short. The cap also protects callers from accidentally requesting millennia.
 for(let guard=0;current<=end&&guard<10000;guard++){
  dates.push(current);
  const currentParsed=parseDate(current);
  if(!currentParsed)break;
  if(cycle==='weekly'){
   const next=addCalendarDays(current,7);
   if(!next)break;
   current=next;
  }else{
   const monthsSinceAnchor=(currentParsed.year-anchor.year)*12+(currentParsed.month-anchor.month);
   const step=cycle==='monthly'?1:cycle==='quarterly'?3:12;
   const next=occurrence(anchor,anchorIso,cycle,Math.floor(monthsSinceAnchor/step)+1);
   if(!next||next<=current)break;
   current=next;
  }
 }
 return dates;
}

function roundDivide(value:bigint,divisor:bigint):bigint{return (value+divisor/2n)/divisor;}
/** Approximate normalized costs: weekly ×52, monthly ×12, quarterly ×4, yearly ×1. */
export function subscriptionEquivalent(amountCents:number,cycle:SubscriptionCycle):SubscriptionEquivalent{
 if(!Number.isSafeInteger(amountCents)||amountCents<0||amountCents>FINANCE_MAX_CENTS||!CYCLES.includes(cycle))throw new Error('Invalid subscription amount or cycle');
 const amount=BigInt(amountCents);
 const yearly=amount*BigInt(cycle==='weekly'?52:cycle==='monthly'?12:cycle==='quarterly'?4:1);
 return {monthly_cents:roundDivide(yearly,12n),yearly_cents:yearly};
}
export function subscriptionEquivalentTotals(subscriptions:readonly Pick<Subscription,'amount_cents'|'cycle'|'status'>[]):SubscriptionEquivalent{
 let monthly=0n,yearly=0n;
 for(const subscription of subscriptions){
  if(subscription.status!=='active')continue;
  const equivalent=subscriptionEquivalent(subscription.amount_cents,subscription.cycle);
  monthly+=equivalent.monthly_cents;
  yearly+=equivalent.yearly_cents;
 }
 return {monthly_cents:monthly,yearly_cents:yearly};
}

/** Actual scheduled charges, not normalized estimates, for `days` calendar dates including `start`. */
export function forecastSubscriptionCharges(subscriptions:readonly Pick<Subscription,'id'|'name'|'amount_cents'|'cycle'|'anchor_date'|'status'>[],start:string,days=30):SubscriptionForecastCharge[]{
 if(!isValidCalendarDate(start)||!Number.isSafeInteger(days)||days<=0)return [];
 const end=addCalendarDays(start,days-1);
 if(!end)return [];
 const charges:SubscriptionForecastCharge[]=[];
 for(const subscription of subscriptions){
  if(subscription.status!=='active'||!Number.isSafeInteger(subscription.amount_cents)||subscription.amount_cents<0||subscription.amount_cents>FINANCE_MAX_CENTS)continue;
  for(const date of renewalDatesInWindow(subscription.anchor_date,subscription.cycle,start,end))charges.push({subscription_id:subscription.id,name:subscription.name,date,amount_cents:subscription.amount_cents});
 }
 return charges.sort((a,b)=>a.date.localeCompare(b.date)||a.name.localeCompare(b.name)||a.subscription_id.localeCompare(b.subscription_id));
}
export function forecastTotalCents(charges:readonly Pick<SubscriptionForecastCharge,'amount_cents'>[]):bigint{
 let total=0n;
 for(const charge of charges){if(Number.isSafeInteger(charge.amount_cents)&&charge.amount_cents>=0)total+=BigInt(charge.amount_cents);}
 return total;
}

export function validateSubscription(values:Pick<Subscription,'name'|'amount_cents'|'cycle'|'anchor_date'|'status'>):string|null{
 if(!values.name.trim())return 'Add a subscription name';
 if(!Number.isSafeInteger(values.amount_cents)||values.amount_cents<0||values.amount_cents>FINANCE_MAX_CENTS)return 'Enter an amount from 0 to 10,000,000,000.00';
 if(!CYCLES.includes(values.cycle))return 'Choose a valid billing cycle';
 if(!isValidCalendarDate(values.anchor_date))return 'Choose a valid next billing date';
 if(!STATUSES.includes(values.status))return 'Choose a valid status';
 return null;
}
