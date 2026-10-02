import { Router, type IRouter } from "express";
import { startCampaignWorker } from "../lib/campaign-worker";
import { requireAuth } from "../middlewares/auth";
import adminUsersRouter from "./admin-users";
import authRouter from "./auth";
import campaignsRouter from "./campaigns";
import dashboardRouter from "./dashboard";
import healthRouter from "./health";
import logsRouter from "./logs";
import recipientsRouter from "./recipients";
import settingsRouter from "./settings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(requireAuth);
router.use(adminUsersRouter);
router.use(dashboardRouter);
router.use(recipientsRouter);
router.use(settingsRouter);
router.use(campaignsRouter);
router.use(logsRouter);
startCampaignWorker();

export default router;
