import type { Response } from "express";

type CampaignEvent = {
  type: "campaign-progress";
  campaignId: number;
};

const connections = new Map<string, Set<Response>>();

export function subscribeToCampaignEvents(
  ownerId: string,
  response: Response,
): () => void {
  let ownerConnections = connections.get(ownerId);
  if (!ownerConnections) {
    ownerConnections = new Set<Response>();
    connections.set(ownerId, ownerConnections);
  }
  ownerConnections.add(response);

  response.write("retry: 5000\n");
  response.write(`event: connected\ndata: {}\n\n`);
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": keep-alive\n\n");
  }, 25_000);

  return () => {
    clearInterval(heartbeat);
    ownerConnections?.delete(response);
    if (ownerConnections?.size === 0) connections.delete(ownerId);
  };
}

export function publishCampaignEvent(ownerId: string, event: CampaignEvent): void {
  const ownerConnections = connections.get(ownerId);
  if (!ownerConnections) return;
  const data = `event: invitation-send\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of ownerConnections) {
    if (response.writableEnded || response.destroyed) {
      ownerConnections.delete(response);
      continue;
    }
    response.write(data);
  }
  if (ownerConnections.size === 0) connections.delete(ownerId);
}

export function disconnectCampaignSubscribers(ownerId: string): void {
  const ownerConnections = connections.get(ownerId);
  if (!ownerConnections) return;
  connections.delete(ownerId);
  for (const response of ownerConnections) {
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}