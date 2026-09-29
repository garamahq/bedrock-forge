import { IsIn, IsOptional } from "class-validator";
import { QUEUES, type QueueName } from "@bedrock-forge/shared";

export class RecoverQueueDto {
  @IsOptional()
  @IsIn(Object.values(QUEUES))
  queue_name?: QueueName;
}
