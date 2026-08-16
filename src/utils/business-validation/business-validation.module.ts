import { Global, Module } from '@nestjs/common';
import { BusinessValidationService } from './business-validation.service';

@Global()
/**
 * Business validation module for reusable business logic checks
 *
 * Provides reusable validation methods to avoid code duplication
 * across services and controllers.
 */
@Module({
  providers: [BusinessValidationService],
  exports: [BusinessValidationService],
})
export class BusinessValidationModule {}
