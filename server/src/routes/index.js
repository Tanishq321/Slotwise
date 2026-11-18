import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { authRouter } from './auth.js';
import { settingsRouter } from './settings.js';
import { facultyRouter, roomsRouter, sectionsRouter, coursesRouter } from './masterData.js';
import { offeringsRouter } from './offerings.js';
import { basketsRouter } from './baskets.js';
import { importRouter } from './import.js';
import { constraintsRouter } from './constraints.js';
import { timetablesRouter } from './timetables.js';
import { adminRouter } from './admin.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);

// Everything below needs a logged-in user. Each router adds its own role checks.
apiRouter.use(requireAuth);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/faculty', facultyRouter);
apiRouter.use('/rooms', roomsRouter);
apiRouter.use('/sections', sectionsRouter);
apiRouter.use('/courses', coursesRouter);
apiRouter.use('/offerings', offeringsRouter);
apiRouter.use('/baskets', basketsRouter);
apiRouter.use('/import', importRouter);
apiRouter.use('/constraints', constraintsRouter);
apiRouter.use('/timetables', timetablesRouter);
apiRouter.use('/', adminRouter);
