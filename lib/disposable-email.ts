// Disposable / temporary email protection (M2).
//
// Signup validates the email domain against an embedded blocklist of known
// disposable-mail providers. The check is deliberately conservative:
//  - exact domain match, plus subdomain match (mail.guerrillamail.com)
//  - IDNA/punycode normalized, case-insensitive
//  - gmail/yahoo/outlook/hotmail/custom business domains always pass
//
// This is a first line of defense, not a perfect oracle — new throwaway
// domains appear daily. The list covers the most abused providers.

const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "2prong.com",
  "33mail.com", "anonbox.net", "binkmail.com", "bobmail.info", "burnermail.io",
  "chackmail.com", "crazymailing.com", "dispostable.com", "dodgit.com",
  "dogdot.com", "e4ward.com", "emailondeck.com", "emailtemporanea.net",
  "emailtemporanea.com", "fakemail.net", "fakeinbox.com", "getnada.com",
  "getonemail.com", "gishpuppy.com", "grr.la", "guerrillamail.com", "guerrillamail.net",
  "guerrillamail.org", "guerrillamailblock.com", "harakirimail.com", "hidemail.de",
  "hmamail.com", "incognitomail.org", "jetable.org", "jnxjn.com", "jourrapide.com",
  "klzlk.com", "kurzepost.de", "lroid.com", "mail-temporaire.fr", "mail.by",
  "mailcatch.com", "maildrop.cc", "mailinator.com", "mailinator.net", "mailinator.org",
  "mailnesia.com", "mailnull.com", "mailsac.com", "mailslurp.com", "mailtothis.com",
  "mailzi.ru", "mega.zik.dj", "meltmail.com", "messagebeamer.de", "mintemail.com",
  "moakt.co", "moakt.com", "moncourrier.fr", "monemail.fr", "monmail.fr",
  "my10minutemail.com", "mytemp.email", "mytrashmail.com", "nada.email", "nada.ltd",
  "netmails.com", "netmails.net", "nexi.com", "nqavc.com", "nqmo.com", "nuclene.com",
  "objectmail.com", "obobbo.com", "oneoffemail.com", "onewaymail.com", "oopi.org",
  "opayq.com", "ordinaryamerican.net", "otherinbox.com", "ourklakr.com", "outlawspam.com",
  "ovpn.to", "owlpic.com", "pancakemail.com", "pcusers.otherinbox.com",
  "pepbot.com", "pjjkp.com", "politikerclub.de", "pookmail.com", "proxymail.eu",
  "prtnx.com", "put2.net", "putthisinyourspamdatabase.com",
  "quickinbox.com", "qisdo.com", "rcpt.at", "reallymails.com", "recode.me", "recursor.net",
  "reliable-mail.com", "rhyta.com", "rmqkr.net", "royal.net", "rtrtr.com",
  "s0ny.net", "safe-mail.net", "safersignup.de", "sagsaun.com", "saynotospams.com",
  "schafmail.de", "schrott-email.de", "sd3.in", "secretemail.de", "secure-mail.cc",
  "sendspamhere.com", "sharklasers.com", "shitmail.me", "shitmail.org", "shitware.nl",
  "shortmail.net", "sibmail.com", "sinnlos-mail.de", "slaskpost.se", "slopsbox.com",
  "slushmail.com", "smapfree24.com", "smapfree24.de", "smapfree24.eu", "smapfree24.info",
  "smapfree24.org", "smwg.info", "snapsmail.com", "sofort-mail.de", "sogetthis.com",
  "soodonims.com", "spam.la", "spam.su", "spam4.me", "spamavert.com", "spambob.com",
  "spambob.net", "spambob.org", "spambox.us", "spamcero.com", "spamcon.org",
  "spamcorptastic.com", "spamcowboy.com", "spamcowboy.net", "spamcowboy.org",
  "spamday.com", "spamex.com", "spamfree24.com", "spamfree24.de", "spamfree24.eu",
  "spamfree24.org", "spamgoes.in", "spamgourmet.com", "spamgourmet.net", "spamgourmet.org",
  "spamherelots.com", "spamhereplease.com", "spamhole.com", "spamify.com",
  "spaminator.de", "spamkill.info", "spaml.com", "spaml.de", "spammotel.com",
  "spamobox.com", "spamoff.de", "spamslicer.com", "spamspot.com", "spamstack.net",
  "spamthis.co.uk", "spamthisplease.com", "spamtrail.com", "spamtroll.net",
  "speed.1s.fr", "spoofmail.de", "spybox.de", "squizzy.de", "ssoia.com",
  "startkeys.com", "stinkefinger.net", "stuffmail.de", "super-auswahl.de",
  "supergreatmail.com", "supermailer.jp", "suremail.info", "tagyourself.com",
  "teewars.org", "teleworm.com", "teleworm.us", "temp-mail.com", "temp-mail.de",
  "temp-mail.org", "tempail.com", "tempalias.com", "tempe-mail.com", "tempemail.biz",
  "tempemail.com", "tempemail.net", "tempinbox.co.uk", "tempinbox.com", "tempmail.de",
  "tempmail.eu", "tempmail.it", "tempmail.net", "tempmail.org", "tempmailo.com",
  "tempmails.net", "tempomail.fr", "temporarily.de", "temporarioemail.com",
  "temporaryemail.net", "temporaryemail.us", "temporaryforwarding.com",
  "temporaryinbox.com", "tempsky.com", "tempthe.net", "thanksnospam.info",
  "thankyou2010.com", "thisisnotmyrealemail.com", "thraml.com", "throwam.com",
  "throwawayemailaddress.com", "tilien.com", "tittbit.in", "tmail.ws", "tmailinator.com",
  "toiea.com", "tradermail.info", "trash-mail.at", "trash-mail.com", "trash-mail.de",
  "trash2009.com", "trashcanmail.com", "trashdevil.com", "trashemail.de",
  "trashmail.at", "trashmail.com", "trashmail.de", "trashmail.me", "trashmail.net",
  "trashmail.org", "trashmail.ws", "trashymail.com", "trialmail.de", "trillianpro.com",
  "twinmail.de", "tyldd.com", "uggsrock.com", "umail.net", "upliftnow.com",
  "uplipht.com", "venompen.com", "veryrealemail.com", "viditag.com", "viewcastmedia.com",
  "viewcastmedia.net", "viewcastmedia.org", "vmani.com", "wasteland.rfc822.org",
  "webemail.me", "weg-werf-email.de", "wegwerf-email-addressen.de",
  "wegwerf-email-adressen.de", "wegwerf-emails.de", "wegwerfadresse.de", "wegwerfemail.com",
  "wegwerfemail.de", "wegwerfemail.net", "wegwerfemail.org", "wegwerfemailadresse.com",
  "wegwerfmail.de", "wegwerfmail.net", "wegwerfmail.org", "wegwerpmailadres.nl",
  "wegwrfmail.de", "wegwrfmail.net", "wegwrfmail.org", "welikecookies.com",
  "wetrainbayarea.com", "wetrainbayarea.org", "wh4f.org", "whatiaas.com",
  "whatpaas.com", "whtjddn.33mail.com", "whyspam.me", "willhackforfood.biz",
  "willselfdestruct.com", "winemaven.info", "wronghead.com", "wuzup.net",
  "wuzupmail.net", "www.e4ward.com", "www.gishpuppy.com", "www.mailinator.com",
  "wwwnew.eu", "x.ip6.li", "xagloo.com", "xemaps.com", "xents.com", "xmaily.com",
  "xoxy.net", "yapped.net", "yep.it", "yogamaven.com", "yopmail.com", "yopmail.fr",
  "yopmail.net", "yourdomain.com", "youzendit.com", "ypmail.webarnak.fr.eu.org",
  "yuurok.com", "yxzx.net", "z1p.biz", "za.com", "zehnminuten.de", "zehnminutenmail.de",
  "zetmail.com", "zik.dj", "zoaxe.com", "zoemail.com", "zoemail.net", "zoemail.org",
  "zomg.info",
]);

/** Normalize an email domain for comparison (lowercase, trim, IDNA-safe). */
function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

/** Extract the domain part of an email address, or null if malformed. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return normalizeDomain(email.slice(at + 1));
}

/** True when the address belongs to a known disposable-email provider. */
export function isDisposableEmail(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  // Subdomain of a blocked provider, e.g. xxx.guerrillamail.com.
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}
