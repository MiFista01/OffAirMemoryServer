import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

/**
 * DTO field matching validator for class-validator
 *
 * Provides field validation functionality including property value comparison,
 * cross-field validation for DTOs, password confirmation matching, and
 * custom validation messages with constraint-based field referencing.
 *
 * @param property - Name of the property to match against
 * @param validationOptions - Optional class-validator validation options
 *
 * @see {@link ValidationOptions} for validation configuration
 * @see {@link ValidationArguments} for validation context
 */
export function Match(property: string, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'match',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [property],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          const [relatedPropertyName] = args.constraints;
          if (!(relatedPropertyName in args.object)) {
            return false;
          }
          const relatedValue = (args.object as any)[relatedPropertyName];
          return value === relatedValue;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must match ${args.constraints[0]}`;
        },
      },
    });
  };
}
