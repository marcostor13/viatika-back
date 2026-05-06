import { Test, TestingModule } from '@nestjs/testing'
import { BadRequestException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { AuthService } from './auth.service'
import { UserService } from '../user/user.service'

jest.mock('bcryptjs')

const mockUserService = {
  findByEmail: jest.fn(),
  create: jest.fn(),
}

const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock.jwt.token'),
}

const mockUser = {
  _id: { toString: () => 'user123' },
  email: 'test@example.com',
  name: 'Test User',
  password: 'hashed_password',
  role: { name: 'Colaborador' },
  client: { _id: { toString: () => 'client123' } },
  permissions: { modules: [], canApproveL1: false, canApproveL2: false },
  isActive: true,
}

describe('AuthService', () => {
  let service: AuthService

  beforeEach(async () => {
    jest.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: mockUserService },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile()
    service = module.get<AuthService>(AuthService)
  })

  describe('register', () => {
    const dto = {
      email: 'new@example.com',
      password: 'pass123',
      name: 'New User',
      roleId: 'roleId',
      clientId: 'clientId',
    }

    it('creates user and returns success message', async () => {
      mockUserService.findByEmail.mockResolvedValue(null)
      mockUserService.create.mockResolvedValue(mockUser)
      const result = await service.register(dto as any)
      expect(mockUserService.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: dto.email })
      )
      expect(result).toEqual({ message: 'Usuario creado correctamente' })
    })

    it('throws BadRequestException when email already exists', async () => {
      mockUserService.findByEmail.mockResolvedValue(mockUser)
      await expect(service.register(dto as any)).rejects.toThrow(
        BadRequestException
      )
      await expect(service.register(dto as any)).rejects.toThrow(
        'El usuario ya existe'
      )
    })

    it('passes null clientId when clientId is empty string', async () => {
      mockUserService.findByEmail.mockResolvedValue(null)
      mockUserService.create.mockResolvedValue(mockUser)
      await service.register({ ...dto, clientId: '' } as any)
      expect(mockUserService.create).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: null })
      )
    })
  })

  describe('validateUser', () => {
    it('returns user without password when credentials are valid', async () => {
      mockUserService.findByEmail.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      const result = await service.validateUser('test@example.com', 'pass123')
      expect(result).not.toHaveProperty('password')
      expect(result).toHaveProperty('email', 'test@example.com')
    })

    it('returns null when user is not found', async () => {
      mockUserService.findByEmail.mockResolvedValue(null)
      const result = await service.validateUser('unknown@example.com', 'pass')
      expect(result).toBeNull()
    })

    it('returns null when password does not match', async () => {
      mockUserService.findByEmail.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(false)
      const result = await service.validateUser('test@example.com', 'wrong')
      expect(result).toBeNull()
    })
  })

  describe('login', () => {
    it('returns access_token and user data on valid credentials', async () => {
      mockUserService.findByEmail.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      const result = await service.login({
        email: 'test@example.com',
        password: 'pass123',
      } as any)
      expect(result).toHaveProperty('access_token', 'mock.jwt.token')
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          email: mockUser.email,
          roles: ['Colaborador'],
        })
      )
    })

    it('throws BadRequestException when credentials are invalid', async () => {
      mockUserService.findByEmail.mockResolvedValue(null)
      await expect(
        service.login({ email: 'wrong@example.com', password: 'bad' } as any)
      ).rejects.toThrow(BadRequestException)
    })

    it('includes clientId and permissions in JWT payload', async () => {
      mockUserService.findByEmail.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      await service.login({
        email: 'test@example.com',
        password: 'pass123',
      } as any)
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'client123',
          permissions: mockUser.permissions,
        })
      )
    })
  })
})
