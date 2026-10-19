const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const sessions = await prisma.liveSession.findMany({
    include: { course: true },
        orderBy: { scheduledAt: 'desc' },
    take: 10,
  });
  console.log('Found sessions:', sessions.length);
  for (const s of sessions) {
    console.log(`ID: ${s.id} | Status: ${s.status} | Course: ${s.course?.title} (${s.courseId})`);
  }

  const session = await prisma.liveSession.findUnique({
    where: { id: 'cmv7tc7jp0002viko3nr92kj5' },
    include: { course: { include: { instructor: true, organization: true } } },
  });
  const enrollments = await prisma.enrollment.findMany({
    where: { courseId: 'cmuy1y6qc0002vigcet5u4rvr' },
    include: { student: true },
  });
  console.log('Students enrolled:', enrollments.map(e => e.student.email));
  const instructor = await prisma.user.findUnique({ where: { email: 'qa.instructor@livetich.test' } });
  await prisma.liveSession.update({
    where: { id: 'cmv7tc7jp0002viko3nr92kj5' },
    data: { status: 'LIVE', endedAt: null },
  });
  console.log('Session set to LIVE!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
