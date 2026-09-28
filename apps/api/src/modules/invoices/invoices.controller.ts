import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { Response } from "express";
import { AuthGuard } from "@nestjs/passport";
import { InvoicesService } from "./invoices.service";
import {
  GenerateInvoiceDto,
  GenerateBulkInvoiceDto,
  GenerateClientInvoiceDto,
  UpdateInvoiceDto,
  QueryInvoicesDto,
} from "./dto/invoice.dto";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ROLES } from "@bedrock-forge/shared";

@Controller("invoices")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MANAGER)
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  findAll(@Query() query: QueryInvoicesDto) {
    return this.invoicesService.findAll(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.invoicesService.findById(id);
  }

  @Get(":id/pdf")
  async getPdf(
    @Param("id", ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response,
  ) {
    const pdfBuffer = await this.invoicesService.generatePdf(id);
    const invoice = await this.invoicesService.findById(id);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="invoice-${invoice.invoice_number}.pdf"`,
      "Content-Length": pdfBuffer.length.toString(),
    });
    return new StreamableFile(pdfBuffer);
  }

  @Post("generate")
  generate(@Body() dto: GenerateInvoiceDto) {
    return this.invoicesService.generate(dto);
  }

  @Post("generate-bulk")
  generateBulk(@Body() dto: GenerateBulkInvoiceDto) {
    return this.invoicesService.generateBulk(dto);
  }

  @Post("generate-client")
  generateForClient(@Body() dto: GenerateClientInvoiceDto) {
    return this.invoicesService.generateForClient(dto);
  }

  @Put(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateInvoiceDto) {
    return this.invoicesService.update(id, dto);
  }

  @Put(":id/mark-paid")
  markAsPaid(@Param("id", ParseIntPipe) id: number) {
    return this.invoicesService.markAsPaid(id);
  }

  @Put(":id/mark-sent")
  markAsSent(@Param("id", ParseIntPipe) id: number) {
    return this.invoicesService.markAsSent(id);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.invoicesService.remove(id);
  }
}
