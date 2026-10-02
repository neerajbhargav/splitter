import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Subscription} from '../src/lib/finance-types.ts';
import {
 addCalendarDays,forecastSubscriptionCharges,forecastTotalCents,isValidCalendarDate,
 nextRenewalDate,renewalDatesInWindow,subscriptionEquivalent,subscriptionEquivalentTotals,
 validateSubscription,
} from '../src/lib/subscription-planner.ts';

function subscription(overrides:Partial<Subscription>={}):Subscription{return {
 id:'sub-1',user_id:'user-1',name:'Example',amount_cents:1000,cycle:'monthly',
 anchor_date:'2025-01-01',status:'active',notes:'',created_at:'2025-01-01',updated_at:'2025-01-01',
 ...overrides,
};}

test('monthly schedules preserve the original month-end day',()=>{
 assert.equal(nextRenewalDate('2025-01-31','monthly','2025-02-01'),'2025-02-28');
 assert.deepEqual(renewalDatesInWindow('2025-01-31','monthly','2025-02-01','2025-04-30'),[
  '2025-02-28','2025-03-31','2025-04-30',
 ]);
 assert.equal(nextRenewalDate('2000-01-31','monthly','2099-12-01'),'2099-12-31');
});

test('quarterly schedules preserve the anchor day instead of drifting',()=>{
 assert.deepEqual(renewalDatesInWindow('2025-01-31','quarterly','2025-02-01','2026-01-31'),[
  '2025-04-30','2025-07-31','2025-10-31','2026-01-31',
 ]);
});

test('yearly leap-day schedules clamp only the non-leap occurrence',()=>{
 assert.deepEqual(renewalDatesInWindow('2024-02-29','yearly','2025-01-01','2028-12-31'),[
  '2025-02-28','2026-02-28','2027-02-28','2028-02-29',
 ]);
});

test('weekly schedules use calendar-day arithmetic without timezone dates',()=>{
 assert.deepEqual(renewalDatesInWindow('2025-01-01','weekly','2025-01-01','2025-01-30'),[
  '2025-01-01','2025-01-08','2025-01-15','2025-01-22','2025-01-29',
 ]);
 assert.equal(nextRenewalDate('2001-01-01','weekly','2026-10-01'),'2026-10-05');
 assert.equal(addCalendarDays('2024-02-28',1),'2024-02-29');
 assert.equal(addCalendarDays('2024-02-29',1),'2024-03-01');
});

test('30-day forecast sums actual charges and excludes inactive subscriptions',()=>{
 const subscriptions=[
  subscription({id:'weekly',name:'Weekly',cycle:'weekly',amount_cents:1000,anchor_date:'2025-01-01'}),
  subscription({id:'monthly',name:'Monthly',cycle:'monthly',amount_cents:2000,anchor_date:'2025-01-15'}),
  subscription({id:'paused',name:'Paused',cycle:'weekly',amount_cents:9999,status:'paused'}),
  subscription({id:'canceled',name:'Canceled',cycle:'monthly',amount_cents:9999,status:'canceled'}),
 ];
 const charges=forecastSubscriptionCharges(subscriptions,'2025-01-01',30);
 assert.deepEqual(charges.map(charge=>[charge.subscription_id,charge.date]),[
  ['weekly','2025-01-01'],['weekly','2025-01-08'],['monthly','2025-01-15'],
  ['weekly','2025-01-15'],['weekly','2025-01-22'],['weekly','2025-01-29'],
 ]);
 assert.equal(forecastTotalCents(charges),7000n);
});

test('equivalents use explicit annual factors and BigInt cent rounding',()=>{
 assert.deepEqual(subscriptionEquivalent(1000,'weekly'),{monthly_cents:4333n,yearly_cents:52000n});
 assert.deepEqual(subscriptionEquivalent(1000,'monthly'),{monthly_cents:1000n,yearly_cents:12000n});
 assert.deepEqual(subscriptionEquivalent(1000,'quarterly'),{monthly_cents:333n,yearly_cents:4000n});
 assert.deepEqual(subscriptionEquivalent(1000,'yearly'),{monthly_cents:83n,yearly_cents:1000n});
 const many=Array.from({length:200},(_,i)=>subscription({id:String(i),cycle:'weekly',amount_cents:1_000_000_000_000}));
 const totals=subscriptionEquivalentTotals(many);
 assert.equal(totals.yearly_cents,10_400_000_000_000_000n);
 assert.equal(totals.monthly_cents,866_666_666_666_600n);
 assert.ok(totals.yearly_cents>BigInt(Number.MAX_SAFE_INTEGER));
});

test('free subscriptions are valid and forecast deterministically',()=>{
 const free=subscription({amount_cents:0,anchor_date:'2025-01-31'});
 assert.equal(validateSubscription(free),null);
 assert.deepEqual(forecastSubscriptionCharges([free],'2025-02-01',30),[
  {subscription_id:'sub-1',name:'Example',date:'2025-02-28',amount_cents:0},
 ]);
});

test('invalid calendar dates and unsafe amounts are rejected safely',()=>{
 for(const value of ['','2025-2-01','2025-02-29','2024-04-31','0000-01-01','10000-01-01'])assert.equal(isValidCalendarDate(value),false,value);
 assert.equal(nextRenewalDate('2025-02-29','monthly','2025-03-01'),null);
 assert.deepEqual(renewalDatesInWindow('2025-01-01','monthly','bad','2025-03-01'),[]);
 assert.match(validateSubscription(subscription({anchor_date:'2025-02-29'}))??'',/valid anchor date/);
 assert.match(validateSubscription(subscription({amount_cents:-1}))??'',/Enter an amount/);
 assert.match(validateSubscription(subscription({amount_cents:1_000_000_000_001}))??'',/Enter an amount/);
});
