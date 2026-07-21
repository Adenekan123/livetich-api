import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { UpdateSectionDto } from './dto/update-section.dto';

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- Courses ----------

  createCourse(instructorId: string, dto: CreateCourseDto) {
    return this.prisma.course.create({
      data: { ...dto, instructorId },
    });
  }

  listCourses() {
    return this.prisma.course.findMany({
      include: {
        instructor: { select: { id: true, name: true } },
        _count: { select: { enrollments: true, sections: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getCourse(id: string) {
    const course = await this.prisma.course.findUnique({
      where: { id },
      include: {
        instructor: { select: { id: true, name: true } },
        sections: { orderBy: { order: 'asc' } },
        _count: { select: { enrollments: true } },
      },
    });
    if (!course) throw new NotFoundException('Course not found');
    return course;
  }

  async updateCourse(instructorId: string, id: string, dto: UpdateCourseDto) {
    await this.assertOwner(instructorId, id);
    return this.prisma.course.update({ where: { id }, data: dto });
  }

  // ---------- Sections ----------

  async addSection(instructorId: string, courseId: string, dto: CreateSectionDto) {
    await this.assertOwner(instructorId, courseId);
    const order = dto.order ?? (await this.nextSectionOrder(courseId));
    try {
      return await this.prisma.section.create({
        data: { courseId, title: dto.title, order },
      });
    } catch (e) {
      throw this.mapDuplicateOrder(e, courseId);
    }
  }

  async updateSection(
    instructorId: string,
    courseId: string,
    sectionId: string,
    dto: UpdateSectionDto,
  ) {
    await this.assertOwner(instructorId, courseId);
    const section = await this.prisma.section.findFirst({
      where: { id: sectionId, courseId },
    });
    if (!section) throw new NotFoundException('Section not found');
    try {
      return await this.prisma.section.update({
        where: { id: sectionId },
        data: dto,
      });
    } catch (e) {
      throw this.mapDuplicateOrder(e, courseId);
    }
  }

  // ---------- Enrollment ----------

  async enroll(studentId: string, courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    try {
      return await this.prisma.enrollment.create({
        data: { courseId, studentId },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Already enrolled');
      }
      throw e;
    }
  }

  async unenroll(studentId: string, courseId: string) {
    const deleted = await this.prisma.enrollment.deleteMany({
      where: { courseId, studentId },
    });
    if (deleted.count === 0) throw new NotFoundException('Not enrolled');
    return { unenrolled: true };
  }

  async listStudents(instructorId: string, courseId: string) {
    await this.assertOwner(instructorId, courseId);
    return this.prisma.enrollment.findMany({
      where: { courseId },
      include: {
        student: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  listEnrolled(studentId: string) {
    return this.prisma.enrollment.findMany({
      where: { studentId },
      include: {
        course: {
          include: { instructor: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---------- Helpers ----------

  private async assertOwner(instructorId: string, courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { instructorId: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (course.instructorId !== instructorId) {
      throw new ForbiddenException('Not your course');
    }
  }

  private async nextSectionOrder(courseId: string): Promise<number> {
    const last = await this.prisma.section.findFirst({
      where: { courseId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    return (last?.order ?? 0) + 1;
  }

  private mapDuplicateOrder(e: unknown, courseId: string): unknown {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      return new ConflictException(
        `A section with that order already exists in course ${courseId}`,
      );
    }
    return e;
  }
}
