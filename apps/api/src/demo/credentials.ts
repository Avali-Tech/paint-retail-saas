import type { DemoCredentials } from './seed.js';

/** The sign-in sheet printed after seeding and kept in .demo/credentials.txt. */
export function formatCredentials(credentials: DemoCredentials, webUrl: string): string {
  const width = (pick: (person: DemoCredentials['people'][number]) => string) =>
    Math.max(...credentials.people.map((person) => pick(person).length));
  const nameWidth = width((person) => person.name);
  const roleWidth = width((person) => person.role);
  const phoneWidth = width((person) => person.phone);
  const storeWidth = width((person) => person.stores);
  const rows = credentials.people.map((person) =>
    [
      person.name.padEnd(nameWidth),
      person.role.padEnd(roleWidth),
      person.phone.padEnd(phoneWidth),
      person.stores.padEnd(storeWidth),
      person.signIn,
    ].join('  '),
  );
  const { twoFactor, operator } = credentials;
  return [
    `${credentials.business} — demo sign-in`,
    `Open ${webUrl} and sign in with a mobile number (or email) and the password below.`,
    '',
    `Password for everyone with one: ${credentials.password}`,
    '',
    ...rows,
    '',
    'Mobile code: counter staff tap "Mobile code" and enter their number. The 6-digit code',
    'appears in the API output of `pnpm demo` (a line starting with [SMS]) and in .demo/api.log.',
    '',
    `Two-factor sign-in: ${twoFactor.name} (${twoFactor.phone}) uses an authenticator app.`,
    'Two-factor is switched off as a business rule for this demo (Settings → Account security),',
    'so the owner and the other admin sign in with just the password.',
    `  Setup key (same after every reset): ${twoFactor.secret}`,
    `  otpauth URI (paste into a QR code generator, or add the key by hand): ${twoFactor.otpauthUri}`,
    `  Recovery codes (each works once; new ones after every reset): ${twoFactor.recoveryCodes.join(' ')}`,
    '',
    `Platform console (the team that runs the service): ${webUrl}/platform`,
    `  ${operator.name}: ${operator.email} and the password above, then an authenticator app.`,
    `  Setup key (same after every reset): ${operator.secret}`,
    `  otpauth URI: ${operator.otpauthUri}`,
    `  Recovery codes (each works once; new ones after every reset): ${operator.recoveryCodes.join(' ')}`,
    '',
  ].join('\n');
}
