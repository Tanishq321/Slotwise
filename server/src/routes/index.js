import { Router } from 'express';
import { canEdit, requireAuth } from '../middleware/auth.js';
import { authRouter } from './auth.js';
import { settingsRouter } from './settings.js';
import { facultyRouter, roomsRouter, sectionsRouter, coursesRouter } from './masterData.js';
import { offeringsRouter } from './offerings.js';
import { basketsRouter } from './baskets.js';
import { importRouter } from './import.js';
import { datasetRouter } from './dataset.js';
import { constraintsRouter } from './constraints.js';
import { timetablesRouter } from './timetables.js';
import { adminRouter } from './admin.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);

// Everything below needs a logged-in user. Each router adds its own role checks.
apiRouter.use(requireAuth);
apiRouter.use('/settings', settingsRouter);
// Master data (who teaches whom, teachers' emails and private availability rules) is
// for admins and HODs only. Students and teachers only read the published timetable.
apiRouter.use('/faculty', canEdit, facultyRouter);
apiRouter.use('/rooms', canEdit, roomsRouter);
apiRouter.use('/sections', canEdit, sectionsRouter);
apiRouter.use('/courses', canEdit, coursesRouter);
apiRouter.use('/offerings', canEdit, offeringsRouter);
apiRouter.use('/baskets', canEdit, basketsRouter);
apiRouter.use('/dataset', canEdit, datasetRouter);
apiRouter.use('/import', canEdit, importRouter);
apiRouter.use('/constraints', canEdit, constraintsRouter);
apiRouter.use('/timetables', timetablesRouter);
apiRouter.use('/', adminRouter);
