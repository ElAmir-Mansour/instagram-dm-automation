/**
 * Country to timezone, for the countries that have exactly one (docs/onboarding/03 §3.6: "timezone
 * (country→IANA)" is added by code, never written by the model). A country with several zones, or one this
 * table does not know, has none: the tenant picks it in the wizard. Pure.
 */
import { isTimeZone } from '../profile/validate.js';

const SINGLE_ZONE: Readonly<Record<string, string>> = {
    SA: 'Asia/Riyadh', AE: 'Asia/Dubai', EG: 'Africa/Cairo', KW: 'Asia/Kuwait', QA: 'Asia/Qatar', BH: 'Asia/Bahrain', OM: 'Asia/Muscat',
    JO: 'Asia/Amman', LB: 'Asia/Beirut', SY: 'Asia/Damascus', IQ: 'Asia/Baghdad', YE: 'Asia/Aden', SD: 'Africa/Khartoum', LY: 'Africa/Tripoli',
    TN: 'Africa/Tunis', DZ: 'Africa/Algiers', MA: 'Africa/Casablanca', IL: 'Asia/Jerusalem', TR: 'Europe/Istanbul',
    GB: 'Europe/London', IE: 'Europe/Dublin', FR: 'Europe/Paris', DE: 'Europe/Berlin', NL: 'Europe/Amsterdam', ES: 'Europe/Madrid',
    IT: 'Europe/Rome', SE: 'Europe/Stockholm', PL: 'Europe/Warsaw', IN: 'Asia/Kolkata', PK: 'Asia/Karachi', BD: 'Asia/Dhaka',
    MY: 'Asia/Kuala_Lumpur', SG: 'Asia/Singapore', PH: 'Asia/Manila', TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', JP: 'Asia/Tokyo',
    KR: 'Asia/Seoul', NG: 'Africa/Lagos', KE: 'Africa/Nairobi', ZA: 'Africa/Johannesburg',
};

/** The one IANA zone of a two-letter country code, or '' when it has several or is unknown. */
export function timezoneForCountry(country: string | null | undefined): string {
    const zone = SINGLE_ZONE[String(country ?? '').toUpperCase()];
    return zone && isTimeZone(zone) ? zone : '';
}
