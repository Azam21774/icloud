import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";

export type CalDAVCalendar = {
  href: string;
  name: string;
  description?: string;
};

export type CalDAVMode = "caldav-scheduling" | "calendar-only";
export type CalDAVStatus =
  | "connected"
  | "authentication-failed"
  | "calendar-unavailable"
  | "server-unavailable";

export type CalDAVTestResult = {
  status: CalDAVStatus;
  calendars: CalDAVCalendar[];
  invitationMode: CalDAVMode;
  message: string;
};

export class CalDAVError extends Error {
  constructor(
    message: string,
    readonly code:
      | "AUTHENTICATION_FAILED"
      | "CALENDAR_UNAVAILABLE"
      | "SCHEDULING_UNAVAILABLE"
      | "SERVER_UNAVAILABLE",
  ) {
    super(message);
    this.name = "CalDAVError";
  }
}

type XmlNode = {
  nodeName: string;
  localName: string | null;
  textContent: string | null;
  getElementsByTagName(name: string): {
    length: number;
    item(index: number): XmlNode | null;
  };
};

const ICLOUD_BASE_URL = "https://caldav.icloud.com/";
const DISCOVERY_PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:current-user-principal />
    <d:principal-URL />
  </d:prop>
</d:propfind>`;
const PRINCIPAL_PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set />
    <c:schedule-outbox-URL />
  </d:prop>
</d:propfind>`;
const CALENDAR_HOME_PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:resourcetype />
    <d:displayname />
    <c:calendar-description />
  </d:prop>
</d:propfind>`;

function localName(node: XmlNode): string {
  return (
    node.localName?.toLowerCase() ??
    node.nodeName.split(":").at(-1)?.toLowerCase() ??
    ""
  );
}

function descendants(root: XmlNode, name: string): XmlNode[] {
  const list = root.getElementsByTagName("*");
  const found: XmlNode[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const node = list.item(index);
    if (node && localName(node) === name.toLowerCase()) found.push(node);
  }
  return found;
}

function firstText(root: XmlNode, name: string): string | undefined {
  return descendants(root, name)
    .map((node) => node.textContent?.trim())
    .find((value) => value);
}

function parseXml(body: string): XmlNode {
  try {
    const doc = new DOMParser().parseFromString(body, "application/xml");
    if (descendants(doc, "parsererror").length > 0) {
      throw new Error("Invalid XML response");
    }
    return doc;
  } catch {
    throw new CalDAVError(
      "Apple Calendar returned an unreadable CalDAV response.",
      "SERVER_UNAVAILABLE",
    );
  }
}

function isICloudUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CalDAVError(
      "Apple Calendar returned an invalid calendar address.",
      "SERVER_UNAVAILABLE",
    );
  }
  if (
    url.protocol !== "https:" ||
    !(
      url.hostname === "icloud.com" ||
      url.hostname.endsWith(".icloud.com")
    ) ||
    url.username ||
    url.password
  ) {
    throw new CalDAVError(
      "Apple Calendar returned a calendar address outside iCloud.",
      "SERVER_UNAVAILABLE",
    );
  }
  return url;
}

function basicAuth(email: string, appPassword: string): string {
  return `Basic ${Buffer.from(`${email}:${appPassword}`, "utf8").toString("base64")}`;
}

async function caldavRequest(
  input: string,
  email: string,
  appPassword: string,
  init: RequestInit,
): Promise<Response> {
  let url = isICloudUrl(input);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          Authorization: basicAuth(email, appPassword),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new CalDAVError(
        "Could not reach Apple Calendar. Check the network and try again.",
        "SERVER_UNAVAILABLE",
      );
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || attempt === 4) {
        throw new CalDAVError(
          "Apple Calendar returned an unsupported redirect.",
          "SERVER_UNAVAILABLE",
        );
      }
      url = isICloudUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new CalDAVError(
        "Apple rejected the iCloud credentials. Check the email and app-specific password.",
        "AUTHENTICATION_FAILED",
      );
    }
    if (!response.ok && response.status !== 207 && response.status !== 412) {
      throw new CalDAVError(
        "Apple Calendar could not complete the CalDAV request.",
        "SERVER_UNAVAILABLE",
      );
    }
    return response;
  }
  throw new CalDAVError(
    "Apple Calendar redirected too many times.",
    "SERVER_UNAVAILABLE",
  );
}

async function propfind(
  href: string,
  email: string,
  appPassword: string,
  body: string,
  depth: "0" | "1",
): Promise<{ document: XmlNode; responseUrl: string; davHeader: string }> {
  const response = await caldavRequest(href, email, appPassword, {
    method: "PROPFIND",
    headers: {
      Depth: depth,
      "Content-Type": "application/xml; charset=utf-8",
    },
    body,
  });
  const text = await response.text();
  return {
    document: parseXml(text),
    responseUrl: response.url || href,
    davHeader: response.headers.get("dav") ?? "",
  };
}

function propertyHref(document: XmlNode, propertyName: string): string | undefined {
  const property = descendants(document, propertyName)[0];
  return property ? firstText(property, "href") : undefined;
}

function resolveICloudHref(href: string, base: string): string {
  return isICloudUrl(new URL(href, base).toString()).toString();
}

function parseCalendars(document: XmlNode, homeUrl: string): CalDAVCalendar[] {
  const calendars: CalDAVCalendar[] = [];
  for (const response of descendants(document, "response")) {
    const responseHref = firstText(response, "href");
    if (!responseHref) continue;
    const responseUrl = resolveICloudHref(responseHref, homeUrl);
    const resourceTypes = descendants(response, "resourcetype");
    const isCalendar = resourceTypes.some((resourceType) =>
      descendants(resourceType, "calendar").some(
        (node) => localName(node) === "calendar",
      ),
    );
    if (!isCalendar) continue;

    const name = firstText(response, "displayname") ?? "iCloud Calendar";
    const description = firstText(response, "calendar-description");
    calendars.push({
      href: responseUrl,
      name,
      ...(description ? { description } : {}),
    });
  }
  return calendars;
}

export async function testICloudConnection(
  email: string,
  appPassword: string,
): Promise<CalDAVTestResult> {
  const root = await propfind(
    ICLOUD_BASE_URL,
    email,
    appPassword,
    DISCOVERY_PROPFIND,
    "0",
  );
  const principalHref =
    propertyHref(root.document, "current-user-principal") ??
    propertyHref(root.document, "principal-URL");
  if (!principalHref) {
    throw new CalDAVError(
      "Apple Calendar did not return an account principal.",
      "SERVER_UNAVAILABLE",
    );
  }

  const principalUrl = resolveICloudHref(principalHref, root.responseUrl);
  const principal = await propfind(
    principalUrl,
    email,
    appPassword,
    PRINCIPAL_PROPFIND,
    "0",
  );
  const calendarHomeHref = propertyHref(principal.document, "calendar-home-set");
  if (!calendarHomeHref) {
    return {
      status: "calendar-unavailable",
      calendars: [],
      invitationMode: "calendar-only",
      message: "The iCloud account connected, but it did not expose a calendar home.",
    };
  }

  const calendarHomeUrl = resolveICloudHref(
    calendarHomeHref,
    principal.responseUrl,
  );
  const home = await propfind(
    calendarHomeUrl,
    email,
    appPassword,
    CALENDAR_HOME_PROPFIND,
    "1",
  );
  const calendars = parseCalendars(home.document, calendarHomeUrl);
  if (calendars.length === 0) {
    return {
      status: "calendar-unavailable",
      calendars: [],
      invitationMode: "calendar-only",
      message: "The iCloud account connected, but no calendars were found.",
    };
  }

  const scheduleOutbox =
    propertyHref(principal.document, "schedule-outbox-URL") !== undefined;
  const schedulingAdvertised = /(?:^|[,; ])calendar-schedule(?:$|[,; ])/i.test(
    `${root.davHeader} ${principal.davHeader} ${home.davHeader}`,
  );
  const invitationMode: CalDAVMode =
    scheduleOutbox && schedulingAdvertised
      ? "caldav-scheduling"
      : "calendar-only";

  return {
    status: "connected",
    calendars,
    invitationMode,
    message:
      invitationMode === "caldav-scheduling"
        ? "Connected. The CalDAV server advertises scheduling support; accepted requests are not proof of inbox delivery."
        : "Connected. This CalDAV server did not advertise invitation scheduling. Events can still be saved with attendee details, but invitation notifications are not confirmed by this connection.",
  };
}

function escapeIcalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function utcIcalDate(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function foldIcalLine(line: string): string {
  const result: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > 73) {
      result.push(current);
      current = ` ${character}`;
      bytes = 1 + characterBytes;
    } else {
      current += character;
      bytes += characterBytes;
    }
  }
  result.push(current);
  return result.join("\r\n");
}

function buildCalendarObject(input: {
  eventUid: string;
  ownerEmail: string;
  attendees: { email: string; name?: string | null }[];
  invitationMode: CalDAVMode;
  title: string;
  location: string;
  description: string;
  url: string;
  startAt: Date;
  durationMinutes: number;
}): string {
  const endAt = new Date(
    input.startAt.getTime() + input.durationMinutes * 60_000,
  );
  const methodLine = input.attendees.length === 0
    ? "METHOD:PUBLISH"
    : input.invitationMode === "caldav-scheduling"
      ? "METHOD:REQUEST"
      : undefined;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Replit//iCloud Invitation Manager//EN",
    "CALSCALE:GREGORIAN",
    ...(methodLine ? [methodLine] : []),
    "BEGIN:VEVENT",
    `UID:${input.eventUid}`,
    `DTSTAMP:${utcIcalDate(new Date())}`,
    `DTSTART:${utcIcalDate(input.startAt)}`,
    `DTEND:${utcIcalDate(endAt)}`,
    "SEQUENCE:0",
    "STATUS:CONFIRMED",
    `SUMMARY:${escapeIcalText(input.title)}`,
    ...(input.description
      ? [`DESCRIPTION:${escapeIcalText(input.description)}`]
      : []),
    ...(input.location
      ? [`LOCATION:${escapeIcalText(input.location)}`]
      : []),
    ...(input.url ? [`URL:${input.url}`] : []),
    ...(input.attendees.length
      ? [
          `ORGANIZER:mailto:${input.ownerEmail}`,
          ...input.attendees.map(
            (attendee) =>
              `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${attendee.name ? `;CN="${escapeIcalText(attendee.name)}"` : ""}:mailto:${attendee.email}`,
          ),
        ]
      : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcalLine).join("\r\n")}\r\n`;
}

export async function createICloudEvent(input: {
  eventUid: string;
  email: string;
  appPassword: string;
  calendarHref: string;
  title: string;
  location: string;
  description?: string;
  url: string;
  startAt: Date;
  durationMinutes: number;
  attendees?: { email: string; name?: string | null }[];
  invitationMode: CalDAVMode;
}): Promise<{
  eventHref: string;
  invitationAcceptedByServer: boolean;
  alreadyExists: boolean;
}> {
  const attendees = input.attendees ?? [];
  const calendarUrl = isICloudUrl(input.calendarHref);
  if (!calendarUrl.pathname.endsWith("/")) calendarUrl.pathname += "/";
  const eventFile = createHash("sha256")
    .update(input.eventUid)
    .digest("hex")
    .slice(0, 40);
  const eventUrl = isICloudUrl(new URL(`${eventFile}.ics`, calendarUrl).toString());
  const body = buildCalendarObject({
    eventUid: input.eventUid,
    ownerEmail: input.email,
    attendees,
    invitationMode: input.invitationMode,
    title: input.title,
    location: input.location,
    description: input.description ?? "",
    url: input.url,
    startAt: input.startAt,
    durationMinutes: input.durationMinutes,
  });
  const response = await caldavRequest(eventUrl.toString(), input.email, input.appPassword, {
    method: "PUT",
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "If-None-Match": "*",
    },
    body,
  });
  if (response.status === 412) {
    const existing = await caldavRequest(eventUrl.toString(), input.email, input.appPassword, {
      method: "GET",
    });
    const existingBody = await existing.text();
    const existingLower = existingBody.toLowerCase();
    const attendeeMatches = attendees.every((attendee) =>
      existingLower.includes(`mailto:${attendee.email.toLowerCase()}`),
    );
    if (
      existing.status === 200 &&
      existingBody.includes(`UID:${input.eventUid}`) &&
      attendeeMatches
    ) {
      return {
        eventHref: eventUrl.toString(),
        invitationAcceptedByServer: false,
        alreadyExists: true,
      };
    }
    throw new CalDAVError(
      "An event with the same identifier already exists, but its details could not be verified.",
      "SERVER_UNAVAILABLE",
    );
  }
  if (response.status !== 201 && response.status !== 204) {
    throw new CalDAVError(
      "Apple Calendar did not confirm that the event was created.",
      "SERVER_UNAVAILABLE",
    );
  }
  return {
    eventHref: eventUrl.toString(),
    invitationAcceptedByServer: Boolean(
      attendees.length > 0 && response.headers.get("schedule-tag"),
    ),
    alreadyExists: false,
  };
}