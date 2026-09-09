import { Module } from "@nestjs/common";
import { DatabaseModule } from "@vendorflow/database";
import { RabbitMqModule } from "../messaging/rabbitmq.module";
import { ConsumerReceiptRepository } from "../consumers/consumer-receipt.repository";
import { OutboxDeliveryRecorderConsumer } from "../consumers/outbox-delivery-recorder.consumer";
import { OutboxMessageRepository } from "./outbox-message.repository";
import { OutboxPublisherService } from "./outbox-publisher.service";

/**
 * The worker's reliability pipeline: the relay that publishes committed intents and the
 * consumer that proves they can be processed exactly once.
 *
 * Both halves live here because they are one contract, not two features. The relay's
 * at-least-once guarantee is only safe because the consumer deduplicates, and the consumer's
 * deduplication is only necessary because the relay may duplicate.
 */
@Module({
  imports: [DatabaseModule, RabbitMqModule],
  providers: [
    OutboxMessageRepository,
    OutboxPublisherService,
    ConsumerReceiptRepository,
    OutboxDeliveryRecorderConsumer
  ],
  exports: [OutboxPublisherService, ConsumerReceiptRepository, OutboxMessageRepository]
})
export class OutboxModule {}
