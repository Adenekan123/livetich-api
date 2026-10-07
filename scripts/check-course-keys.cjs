const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const course = await prisma.course.findFirst({
    where: { title: 'Rust Ownership & Borrowing' },
    select: { id: true, title: true, pluginKeys: true, organizationId: true }
  });
  console.log('COURSE:', course);

  if (course && !course.pluginKeys) {
    await prisma.course.update({
      where: { id: course.id },
      data: { pluginKeys: ['code-instruction', 'test-prep'] }
    });
    console.log('UPDATED course pluginKeys to include code-instruction!');
  }
}

main().finally(() => prisma.$disconnect());
