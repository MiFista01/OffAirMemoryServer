import {
  ValidationOptions,
  registerDecorator,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

/**
 * Custom password strength validator for class-validator
 *
 * Provides password strength validation with configurable minimum requirements
 * including length checks, character type validation (uppercase, lowercase,
 * numbers, special characters), and scoring system from 1-6 strength levels.
 *
 * @param minStrength - Minimum required password strength (1-6, default: 4)
 * @param validationOptions - Optional class-validator validation options
 *
 * @example
 * class CreateUserDto {
 *   //@PasswordStrength(4)
 *   password: string;
 * }
 *
 * @example
 * class AdminCreateUserDto {
 *   //@PasswordStrength(5, { message: 'Admin passwords must be very strong' })
 *   password: string;
 * }
 */
@ValidatorConstraint({ name: 'PasswordStrength', async: false })
class PasswordStrengthConstraint implements ValidatorConstraintInterface {
  validate(password: any, args: ValidationArguments) {
    if (!password || typeof password !== 'string') return false;

    const minStrength = args.constraints[0] || 4;
    const strength = this.getPasswordStrength(password);

    return strength >= minStrength;
  }
  defaultMessage(args: ValidationArguments) {
    const minStrength = args.constraints[0] || 4;
    return `Password strength must be at least ${minStrength}/6. Use uppercase, lowercase, numbers and special characters.`;
  }

  private getPasswordStrength(password: string): number {
    let score = 0;

    if (password.length < 5) {
      return 0;
    }

    if (password.length >= 8) score += 2;
    else if (password.length >= 5) score += 1;

    if (/[a-z]/.test(password)) score += 1;
    if (/[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;

    return Math.min(score, 6);
  }
}

export function PasswordStrength(
  minStrength: number = 4,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'passwordStrength',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [minStrength],
      options: validationOptions,
      validator: PasswordStrengthConstraint,
    });
  };
}
