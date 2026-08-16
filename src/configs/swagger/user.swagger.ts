export const profileSwaggerBodySearch = {
  default: {
    value: {
      nickname: 'John Doe',
    },
  },
  'with relations': {
    value: {
      nickname: 'John Doe',
      relations: ['user'],
    },
  },
};

export const profileSwaggerBodyUpdateAvatar = {
  type: 'object',
  properties: {
    'avatar[]': {
      description: 'Avatar image file (PNG, JPG, JPEG)',
      type: 'array',
      items: {
        type: 'string',
        format: 'binary',
      },
    },
    nickname: {
      type: 'string',
      description: 'User nickname',
      example: 'John Doe',
    },
  },
  required: ['avatar[]'],
};

export const userSwaggerBodySearch = {
  default: {
    value: {
      nickname: 'John Doe',
    },
  },
  'with relations': {
    value: {
      nickname: 'John Doe',
      relations: ['profile', 'auth'],
    },
  },
};

export const userAuthSwaggerBodyUpdate = {
  default: {
    value: {
      userId: 1,
      password: 'qawsQA123!',
    },
  },
};
