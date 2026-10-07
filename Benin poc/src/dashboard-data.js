'use strict';

const crypto = require('crypto');

/** Deterministic dummy numbers derived from the verified identity. */
function seed(claims) {
  const h = crypto.createHash('sha256').update(`${claims.family_name}|${claims.given_name}|${claims.birth_date}`).digest();
  return (i, mod) => h.readUInt32BE(i * 4 % 28) % mod;
}

function bedc(claims) {
  const r = seed(claims);
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ date: d, kwh: 140 + r(i, 120) });
  }
  const tariff = 125; // FCFA / kWh, dummy
  const bills = months.slice(-4).reverse().map((m, i) => ({
    date: m.date,
    amount: m.kwh * tariff,
    paid: i !== 0
  }));
  return {
    accountNumber: `BJ-${String(r(1, 90000000) + 10000000)}`,
    meterNumber: `0471${String(r(2, 9000000) + 1000000)}`,
    tariffBand: ['A', 'B', 'C'][r(3, 3)],
    balance: bills[0].amount,
    lastPayment: { amount: bills[1].amount, date: new Date(now.getFullYear(), now.getMonth(), 3) },
    unitsRemaining: 20 + r(4, 80),
    serviceAddress: 'Lot 214, Quartier Haie Vive, Cotonou',
    usage: months,
    maxKwh: Math.max(...months.map((m) => m.kwh)),
    bills
  };
}

function fda(claims) {
  const r = seed(claims);
  const now = new Date();
  const day = (offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return {
    healthId: `BJ-SANTE-${String(r(1, 900000) + 100000)}`,
    appointments: [
      { date: day(6), time: '09:30', place: 'CNHU-HKM, Cotonou', service: { en: 'General consultation', fr: 'Consultation générale' } },
      { date: day(27), time: '14:00', place: 'Hôpital de Zone de Porto-Novo', service: { en: 'Dental check-up', fr: 'Contrôle dentaire' } }
    ],
    vaccinations: [
      { vaccine: 'BCG', date: '1995-09-20', centre: 'CS Porto-Novo' },
      { vaccine: { en: 'Yellow fever', fr: 'Fièvre jaune' }, date: '2016-03-11', centre: 'CNHU-HKM' },
      { vaccine: 'Tetanus (Td)', date: '2022-07-05', centre: 'CS Akpakpa' }
    ]
  };
}

module.exports = { bedc, fda };
