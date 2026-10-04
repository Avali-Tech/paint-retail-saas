import { gstinCheckCharacter } from '@paint/shared';
import type { Random } from './random.js';

/** Telangana's GST state code; every demo business is in Hyderabad. */
export const TELANGANA = '36';

export const FIRST_NAMES = [
  'Ramesh',
  'Suresh',
  'Mahesh',
  'Venkat',
  'Srinivas',
  'Ravi',
  'Prakash',
  'Naveen',
  'Sandeep',
  'Anil',
  'Rajesh',
  'Kiran',
  'Praveen',
  'Harish',
  'Vijay',
  'Mohan',
  'Satish',
  'Ganesh',
  'Abdul',
  'Imran',
  'Salman',
  'Joseph',
  'Thomas',
  'Gurpreet',
  'Lakshmi',
  'Padma',
  'Swathi',
  'Divya',
  'Kavitha',
  'Sravani',
  'Anitha',
  'Bhavani',
  'Fatima',
  'Shabana',
  'Mary',
  'Pooja',
] as const;

export const SURNAMES = [
  'Reddy',
  'Rao',
  'Goud',
  'Naidu',
  'Yadav',
  'Chary',
  'Varma',
  'Sharma',
  'Gupta',
  'Agarwal',
  'Jain',
  'Patel',
  'Khan',
  'Shaikh',
  'Siddiqui',
  'Mudiraj',
  'Kumar',
  'Prasad',
  'Murthy',
  'Pillai',
  'Singh',
  'Fernandes',
] as const;

/** Hyderabad localities with their PIN codes. */
export const LOCALITIES = [
  { area: 'Ameerpet', pincode: '500016' },
  { area: 'Begumpet', pincode: '500016' },
  { area: 'Banjara Hills', pincode: '500034' },
  { area: 'Jubilee Hills', pincode: '500033' },
  { area: 'Madhapur', pincode: '500081' },
  { area: 'Gachibowli', pincode: '500032' },
  { area: 'Kondapur', pincode: '500084' },
  { area: 'Kukatpally', pincode: '500072' },
  { area: 'KPHB Colony', pincode: '500085' },
  { area: 'Miyapur', pincode: '500049' },
  { area: 'Nizampet', pincode: '500090' },
  { area: 'Secunderabad', pincode: '500003' },
  { area: 'Marredpally', pincode: '500026' },
  { area: 'Bowenpally', pincode: '500011' },
  { area: 'Malkajgiri', pincode: '500047' },
  { area: 'Tarnaka', pincode: '500017' },
  { area: 'Sainikpuri', pincode: '500094' },
  { area: 'Kompally', pincode: '500014' },
] as const;
export type Locality = (typeof LOCALITIES)[number];

export const STREETS = [
  'Road No. 12',
  'Main Road',
  'Gandhi Nagar',
  'Vivekananda Nagar',
  'Srinagar Colony',
  'Prashanth Nagar',
  'MIG Colony',
  'Defence Colony',
  'Sai Nagar',
  'Lakshmi Nagar',
] as const;

/** A person's name, e.g. "Venkat Reddy". */
export function personName(random: Random): string {
  return `${random.pick(FIRST_NAMES)} ${random.pick(SURNAMES)}`;
}

/**
 * Hands out Indian mobile numbers (+91, starting 9) that never repeat within
 * one generator, so the API's duplicate-mobile check never trips.
 */
export class PhoneBook {
  private issued = 0;

  constructor(private readonly random: Random) {}

  /** Random-looking, but the last four digits count up, so no number repeats. */
  next(): string {
    this.issued += 1;
    return `+919${this.random.digits(5)}${String(this.issued).padStart(4, '0')}`;
  }
}

/** The fourth PAN character: the kind of holder. */
export type PanHolder = 'P' | 'F' | 'C';

/** A well-formed PAN whose fifth letter is the first letter of `name`. */
export function panFor(random: Random, name: string, holder: PanHolder): string {
  const initial = /[A-Z]/.exec(name.toUpperCase())?.[0] ?? 'X';
  return `${random.letters(3)}${holder}${initial}${random.digits(4)}${random.letters(1)}`;
}

/** A Telangana GSTIN with the correct GSTN check character, built on a PAN. */
export function gstinFor(pan: string, entity = 1): string {
  const first14 = `${TELANGANA}${pan}${String(entity)}Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
}

/**
 * An EAN-13 barcode in the "2" range, which GS1 reserves for use inside a
 * business, so demo barcodes never clash with real products.
 */
export function internalEan13(sequence: number): string {
  const first12 = `2${String(sequence).padStart(11, '0')}`;
  let sum = 0;
  for (let index = 0; index < first12.length; index++) {
    sum += Number(first12.charAt(index)) * (index % 2 === 0 ? 1 : 3);
  }
  return `${first12}${String((10 - (sum % 10)) % 10)}`;
}
