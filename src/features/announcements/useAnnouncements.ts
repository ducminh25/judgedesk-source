import { useEffect, useSyncExternalStore } from "react";
import { announcementClient } from "./announcement-client.js";
import { AnnouncementController } from "./announcement-controller.js";
export const announcementController = new AnnouncementController(announcementClient);
export function useAnnouncements(controller = announcementController) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => { void controller.start(); }, [controller]);
  return { ...state, controller };
}
